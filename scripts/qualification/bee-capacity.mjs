import assert from "node:assert/strict";
export function requiredChildReservation(childReserveBytes, beeSeed) {
  assert(Number.isSafeInteger(childReserveBytes) && childReserveBytes > 0);
  const allocated = beeSeed?.allocatedBytes ?? 0;
  assert(Number.isSafeInteger(allocated) && allocated >= 0);
  const required = childReserveBytes * (1 + Math.ceil(allocated / childReserveBytes));
  assert(Number.isSafeInteger(required));
  return required;
}
