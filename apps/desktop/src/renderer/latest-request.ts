/** Each response must still own the request slot before updating its view. */
export class LatestRequest {
  #generation = 0;
  public begin(): () => boolean {
    const generation = ++this.#generation;
    return () => generation === this.#generation;
  }
  public invalidate(): void {
    this.#generation++;
  }
}
