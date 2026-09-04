import { keccak256, toUtf8Bytes } from "ethers";
import type { FactoringUnit, Hex } from "./types";

const day = 24 * 60 * 60;
const acceptedAt = Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1_000);

function fixture(index: number, overrides: Partial<FactoringUnit> = {}): FactoringUnit {
  const id = String(index).padStart(3, "0");
  return {
    fuId: `FU-${id}`,
    obligorId: `OBLIGOR-${String(((index - 1) % 4) + 1).padStart(2, "0")}`,
    faceValue: 1_000_000_00n,
    dueDate: acceptedAt + (30 + index) * day,
    acceptedAt,
    currency: "INR",
    buyerAccepted: true,
    previouslyFinanced: true,
    assignmentConfirmed: true,
    evidenceHash: keccak256(toUtf8Bytes(`synthetic-evidence-FU-${id}`)) as Hex,
    ...overrides,
  };
}

export const demoFactoringUnits: FactoringUnit[] = [
  ...Array.from({ length: 10 }, (_, index) => fixture(index + 1)),
  fixture(11, { buyerAccepted: false }),
  fixture(12, { assignmentConfirmed: false }),
];
