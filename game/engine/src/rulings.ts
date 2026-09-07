import { RULINGS } from "./rulings.generated.ts";
export { RULINGS } from "./rulings.generated.ts";

export type Rounding = "floor" | "round";

export function applyRounding(x: number): number {
  return RULINGS.ROUNDING === "floor" ? Math.floor(x) : Math.round(x);
}
