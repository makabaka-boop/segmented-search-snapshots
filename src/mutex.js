export class Mutex {
  constructor() {
    this.queue = Promise.resolve();
  }

  async run(task) {
    let release;
    const previous = this.queue;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
