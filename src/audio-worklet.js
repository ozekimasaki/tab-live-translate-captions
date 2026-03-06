class DeepframPcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 16000;
    this.chunkSize = Math.round(this.targetSampleRate / 10);
    this.silenceThreshold = 0.01;
    this.silentForMs = 0;
    this.pending = [];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input?.[0]) {
      return true;
    }

    const monoChannel = input[0];

    if (output?.[0]) {
      output[0].set(monoChannel);
    }

    const pcmChunk = this.downsample(monoChannel, sampleRate, this.targetSampleRate);
    for (let index = 0; index < pcmChunk.length; index += 1) {
      this.pending.push(pcmChunk[index]);
    }

    while (this.pending.length >= this.chunkSize) {
      const buffer = new Int16Array(this.pending.splice(0, this.chunkSize));
      const level = this.calculateRms(buffer);
      const chunkDurationMs = Math.round((buffer.length / this.targetSampleRate) * 1000);
      const isSilent = level < this.silenceThreshold;

      this.silentForMs = isSilent ? this.silentForMs + chunkDurationMs : 0;

      this.port.postMessage(
        {
          audioBuffer: buffer.buffer,
          level,
          isSilent,
          silentForMs: this.silentForMs
        },
        [buffer.buffer]
      );
    }

    return true;
  }

  downsample(input, inputSampleRate, targetSampleRate) {
    if (inputSampleRate === targetSampleRate) {
      return this.toInt16(input);
    }

    const sampleRateRatio = inputSampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.round(input.length / sampleRateRatio));
    const output = new Int16Array(outputLength);
    let outputIndex = 0;
    let sourceIndex = 0;

    while (outputIndex < outputLength) {
      const nextSourceIndex = Math.round((outputIndex + 1) * sampleRateRatio);
      let accumulator = 0;
      let count = 0;

      for (let index = sourceIndex; index < nextSourceIndex && index < input.length; index += 1) {
        accumulator += input[index];
        count += 1;
      }

      output[outputIndex] = this.floatTo16BitPCM(count ? accumulator / count : 0);
      outputIndex += 1;
      sourceIndex = nextSourceIndex;
    }

    return output;
  }

  toInt16(input) {
    const output = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      output[index] = this.floatTo16BitPCM(input[index]);
    }
    return output;
  }

  floatTo16BitPCM(sample) {
    const clipped = Math.max(-1, Math.min(1, sample));
    return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
  }

  calculateRms(buffer) {
    if (!buffer.length) {
      return 0;
    }

    let sum = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const normalized = buffer[index] / 0x7fff;
      sum += normalized * normalized;
    }

    return Math.sqrt(sum / buffer.length);
  }
}

registerProcessor("deepfram-pcm-recorder", DeepframPcmRecorderProcessor);
