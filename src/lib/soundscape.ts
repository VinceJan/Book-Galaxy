export class Soundscape {
  private context?: AudioContext
  private master?: GainNode
  private ambient?: OscillatorNode
  private ambientGain?: GainNode
  private enabled = false

  async enable(): Promise<void> {
    this.context ??= new AudioContext()
    await this.context.resume()
    if (!this.master) {
      this.master = this.context.createGain()
      this.master.gain.value = 0.16
      this.master.connect(this.context.destination)
    }
    if (!this.ambient) this.startAmbient()
    this.enabled = true
    const now = this.context.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setTargetAtTime(0.16, now, 0.04)
  }

  disable(): void {
    this.enabled = false
    this.master?.gain.setTargetAtTime(0, this.context?.currentTime ?? 0, 0.12)
  }

  private startAmbient(): void {
    if (!this.context || !this.master) return
    this.ambient = this.context.createOscillator()
    this.ambientGain = this.context.createGain()
    const filter = this.context.createBiquadFilter()
    this.ambient.type = 'sine'
    this.ambient.frequency.value = 48
    this.ambientGain.gain.value = 0.018
    filter.type = 'lowpass'
    filter.frequency.value = 180
    this.ambient.connect(filter).connect(this.ambientGain).connect(this.master)
    this.ambient.start()
  }

  private tone(frequency: number, duration: number, volume: number): void {
    if (!this.enabled || !this.context || !this.master) return
    this.master.gain.setTargetAtTime(0.16, this.context.currentTime, 0.08)
    const oscillator = this.context.createOscillator()
    const gain = this.context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, this.context.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.015, this.context.currentTime + duration)
    gain.gain.setValueAtTime(0, this.context.currentTime)
    gain.gain.linearRampToValueAtTime(volume, this.context.currentTime + 0.04)
    gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + duration)
    oscillator.connect(gain).connect(this.master)
    oscillator.start()
    oscillator.stop(this.context.currentTime + duration + 0.04)
  }

  focus(seed = 0): void {
    this.tone(220 + (seed % 7) * 18, 0.8, 0.08)
  }

  detour(seed = 0): void {
    this.tone(146 + (seed % 5) * 12, 1.8, 0.1)
    window.setTimeout(() => this.tone(232 + (seed % 6) * 15, 2.1, 0.07), 130)
  }

  imprint(): void {
    this.tone(110, 3.2, 0.1)
    window.setTimeout(() => this.tone(164.8, 2.8, 0.065), 180)
    window.setTimeout(() => this.tone(246.9, 2.4, 0.045), 360)
  }

  dispose(): void {
    this.ambient?.stop()
    void this.context?.close()
  }
}
