# 带修订号的文档倒排索引服务

这是一个无外部依赖的 Node.js 实现。文档写入先进内存缓冲，随后刷成不可变 JSON 倒排索引段；更新和删除以更高修订号和墓碑表示。查询在创建时物化不可变快照，分页游标绑定该快照，因此写入、刷段或合并都不会改变翻页结果。

## 安装与测试

```bash
npm test
```

要求 Node.js 20+。

## 基本用法

```js
import { DocumentService, referenceSearch } from 'revisioned-document-index';

const service = await DocumentService.open('/var/lib/doc-index', {
  flushThreshold: 100,
  snapshotTtlMs: 30 * 60 * 1000,
  maxDocuments: 1000,
});

await service.put('doc-a', 3, 'The quick brown fox');
await service.delete('doc-b', 4);

// 手动刷内存缓冲；达到 flushThreshold 时也会后台调度
await service.flush();

// 多个段合并为一个新的不可变段
await service.merge();

const page = await service.query('quick "brown fox"', {
  pageSize: 20,
});

const next = await service.query('quick "brown fox"', {
  pageSize: 20,
  cursor: page.nextCursor,
});
```

查询语法：

- ASCII 字母数字 token：`[A-Za-z0-9]+`，大小写不敏感。
- 未加引号的多个词项取交集。
- 双引号表示连续短语，例如 `"quick brown"`。
- 短语内的词项也会自动加入交集条件。

每条命中返回：

```js
{
  docId: 'doc-a',
  revision: 3,
  text: '...',
  evidence: {
    matchedTerms: [
      { term: 'quick', positions: [1] }
    ],
    phrases: [
      { terms: ['quick', 'brown'], starts: [{ position: 1, end: 2 }] }
    ]
  }
}
```

`referenceSearch(latestDocuments, query)` 是直接扫描最新文档的参考实现，测试用它和索引快照对拍。

## 修订规则

- `put(id, rev, text)` 和 `delete(id, rev)` 都要求非负整数修订号。
- 新写入的修订号必须大于当前修订号。
- 相同修订号、相同内容是幂等写入；相同修订号但内容不同会报冲突。
- 删除一个从未存在的文档会报错；先删除、再用更高修订号重新创建是允许的。
- 服务最多维护 1000 份当前未删除文档，可通过 `maxDocuments` 调整。

## 持久化与恢复

数据目录包含：

- `manifest.json`：当前已发布清单。
- `segment-000000000001.json` 等不可变段文件。
- 临时文件以 `.tmp` 结尾。

段和清单都采用“临时文件写入并 `fsync` → 原子 rename → 目录 `fsync`”发布。恢复时：

1. 没有清单：删除遗留段和临时文件，从空状态启动。
2. 清单有效：只加载清单内段；删除未发布段和临时文件。
3. 清单引用的段缺失或格式错误：显式报错，不静默发布不完整状态。

段合并只通过新清单原子切换。旧段是否能删除取决于两类状态：

- 是否已不在当前清单；
- 是否仍被分页快照引用。

## 快照、分页和段回收

第一次查询会创建快照并返回第一页。快照保存该时刻每篇命中文档的词位，因此：

- 后续更新不会改变当前游标结果；
- 新文档不会混入旧查询；
- 删除和更新不会造成漏页或重复；
- 段合并后旧段仍由旧快照持有，直到游标翻完、显式释放或快照 TTL 到期。

游标是 base64url 编码的不透明 token，包含快照 ID 和上一页最后一个文档 ID。最后一页后快照自动释放；也可以显式管理：

```js
const snapshot = await service.createSnapshot();
await service.releaseSnapshot(snapshot.id);
```

重启后旧分页游标不再有效；可查询状态以重启时恢复出的最新清单为准。

## 失败注入

```js
service.injectFault('segmentWrite');  // 下一次写段失败一次
service.injectFault('manifestWrite'); // 下一次写清单失败一次
service.injectFault('reclaim');       // 下一次回收旧段失败一次
```

- 写段失败：清单未变，内存缓冲恢复，服务继续可查询。
- 写清单失败：若失败发生在原子 rename 前，保持旧清单；若 rename 已成功但目录同步失败，重启后以已落盘清单为准。
- 回收失败：新清单和新段仍已发布，旧段保留并放入 orphan 集合，之后重试 `reclaimOrphans()` 或重启清理。

## 主要 API

- `DocumentService.open(directory, options?)`
- `put(id, revision, text)`
- `delete(id, revision)`
- `flush()`
- `merge()`
- `query(query, { pageSize?, cursor? })`
- `createSnapshot()`
- `releaseSnapshot(snapshotId)`
- `reclaimOrphans()`
- `stats()`
- `close()`
