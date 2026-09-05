import { expect,test } from "vitest";
import { id } from "ethers";
import { collectionCommandIdentity,validateCollectionCommand } from "../src/collection-command";
const body={fuId:"FU-003",amountMinorUnits:"100",settlementReference:"SETTLE-123",settledAt:"2026-01-01T00:00:00Z",expectedStateVersion:"0"};
test("canonical identity binds source, pool, receivable, amount and time",()=>{
 const command=validateCollectionCommand(id("pool"),body);
 const identity=collectionCommandIdentity(command);
 expect(collectionCommandIdentity(validateCollectionCommand(id("pool"),{...body,settledAt:"2026-01-01T00:00:00.000Z"}))).toEqual(identity);
 for(const change of [{fuId:"FU-004"},{amountMinorUnits:"101"},{settledAt:"2026-01-02T00:00:00Z"},{settlementReference:"SETTLE-124"}])expect(collectionCommandIdentity(validateCollectionCommand(id("pool"),{...body,...change})).payloadHash).not.toBe(identity.payloadHash);
 expect(collectionCommandIdentity(validateCollectionCommand(id("other-pool"),body)).sourceEventId).not.toBe(identity.sourceEventId);
});
test("rejects unsafe amounts, impossible dates, caller hashes and version coercion",()=>{
 for(const change of [{amountMinorUnits:100},{amountMinorUnits:"01"},{amountMinorUnits:"-1"},{settledAt:"2026-02-30T00:00:00Z"},{payloadHash:id("caller")},{expectedStateVersion:0}])expect(()=>validateCollectionCommand(id("pool"),{...body,...change})).toThrow();
});
