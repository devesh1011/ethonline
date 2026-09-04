import { concat, getBytes, keccak256 } from "ethers";
import type { Hex } from "./types";

function compareHex(left: Hex, right: Hex): number {
  return left.toLowerCase().localeCompare(right.toLowerCase());
}

export function hashPair(left: Hex, right: Hex): Hex {
  const [first, second] = compareHex(left, right) <= 0 ? [left, right] : [right, left];
  return keccak256(concat([getBytes(first), getBytes(second)])) as Hex;
}

export function merkleRoot(inputLeaves: Hex[]): Hex {
  if (inputLeaves.length === 0) {
    return keccak256("0x") as Hex;
  }

  let level = [...inputLeaves].sort(compareHex);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      if (!left) throw new Error("Missing Merkle leaf");
      const right = level[index + 1] ?? left;
      next.push(hashPair(left, right));
    }
    level = next;
  }

  const root = level[0];
  if (!root) throw new Error("Merkle root unavailable");
  return root;
}

export function merkleProof(inputLeaves: Hex[], target: Hex): Hex[] {
  let level = [...inputLeaves].sort(compareHex);
  let index = level.findIndex((leaf) => leaf.toLowerCase() === target.toLowerCase());
  if (index < 0) throw new Error("Target leaf is not in Merkle tree");
  const proof: Hex[] = [];

  while (level.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = level[siblingIndex] ?? level[index];
    if (!sibling) throw new Error("Merkle sibling unavailable");
    proof.push(sibling);
    const next: Hex[] = [];
    for (let cursor = 0; cursor < level.length; cursor += 2) {
      const left = level[cursor];
      if (!left) throw new Error("Missing Merkle node");
      next.push(hashPair(left, level[cursor + 1] ?? left));
    }
    index = Math.floor(index / 2);
    level = next;
  }

  return proof;
}

/** Builds each tree level once so large imports do not rehash the tree per FU. */
export function merkleProofs(inputLeaves: Hex[]): Map<Hex, Hex[]> {
  const firstLevel = [...inputLeaves].sort(compareHex);
  const levels: Hex[][] = [firstLevel];
  let level = firstLevel;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) next.push(hashPair(level[index]!, level[index + 1] ?? level[index]!));
    levels.push(next);
    level = next;
  }
  return new Map(firstLevel.map((leaf, leafIndex) => {
    let index = leafIndex;
    const proof: Hex[] = [];
    for (const nodes of levels.slice(0, -1)) {
      proof.push(nodes[index % 2 === 0 ? index + 1 : index - 1] ?? nodes[index]!);
      index = Math.floor(index / 2);
    }
    return [leaf, proof];
  }));
}
