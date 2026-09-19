const OPENINGS = ['<|DSML|tool_calls>', '<｜DSML｜tool_calls>', '<||DSML||tool_calls>'];
const DONE = '<|DS2_AGENT_DONE|>';
const MAX_CONTROL = Math.max(DONE.length, ...OPENINGS.map(value => value.length));

export class IncrementalProtocolScanner {
  marker = -1;
  agentDoneCandidate = -1;
  lastAgentDone = undefined;

  #pending = '';
  #offset = 0;
  #fence;
  #lineWhitespace = true;
  #prefix = '';
  #indent = 0;
  #openingChar;
  #openingLength = 0;
  #openingEnded = false;

  feed(value) {
    this.#pending += value;
    this.#scan(false);
  }

  finish() {
    this.#scan(true);
  }

  #scan(final) {
    const length = final ? this.#pending.length : Math.max(0, this.#pending.length - MAX_CONTROL + 1);
    for (let index = 0; index < length; index++) {
      const absolute = this.#offset + index;
      if (this.marker < 0 && this.#lineWhitespace && !this.#fenceAtPosition()
        && OPENINGS.some(opening => this.#pending.startsWith(opening, index))) this.marker = absolute;
      if (this.#pending.startsWith(DONE, index)) {
        const literal = Boolean(this.#fenceAtPosition()) || /^ {0,3}>/.test(this.#prefix)
          || /^(?: {4}|\t)/.test(this.#prefix);
        this.lastAgentDone = { index: absolute, literal };
        if (!literal && this.agentDoneCandidate < 0) this.agentDoneCandidate = absolute;
      }
      this.#consume(this.#pending[index]);
    }
    this.#pending = this.#pending.slice(length);
    this.#offset += length;
  }

  #fenceAtPosition() {
    if (this.#openingLength < 3) return this.#fence;
    if (!this.#fence) return { char: this.#openingChar, length: this.#openingLength };
    return this.#fence.char === this.#openingChar && this.#openingLength >= this.#fence.length
      ? undefined : this.#fence;
  }

  #consume(char) {
    if (char === '\n') {
      if (this.#openingLength >= 3) {
        if (!this.#fence) this.#fence = { char: this.#openingChar, length: this.#openingLength };
        else if (this.#fence.char === this.#openingChar && this.#openingLength >= this.#fence.length) this.#fence = undefined;
      }
      this.#lineWhitespace = true;
      this.#prefix = '';
      this.#indent = 0;
      this.#openingChar = undefined;
      this.#openingLength = 0;
      this.#openingEnded = false;
      return;
    }
    if (this.#prefix.length < 5) this.#prefix += char;
    if (!/\s/.test(char)) this.#lineWhitespace = false;
    if (this.#openingEnded) return;
    if (!this.#openingChar) {
      if (char === ' ' && this.#indent < 4) { this.#indent++; return; }
      if (this.#indent <= 3 && (char === '`' || char === '~')) {
        this.#openingChar = char;
        this.#openingLength = 1;
      } else this.#openingEnded = true;
    } else if (char === this.#openingChar) this.#openingLength++;
    else this.#openingEnded = true;
  }
}
