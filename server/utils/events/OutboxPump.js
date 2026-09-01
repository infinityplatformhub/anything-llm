class OutboxPump {
  constructor({ bus, intervalMs = 1000, onError = console.error }) {
    this.bus = bus;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.timer = null;
    this.running = false;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.bus.deliver();
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.tick().catch(this.onError);
    this.timer = setInterval(() => this.tick().catch(this.onError), this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

module.exports = { OutboxPump };
