import {describe,it,expect} from "vitest";
import {requireRestoredSourceProof} from "../scripts/supabase-refresh-rehearsal.js";

describe("full source comparison binds independent backup evidence",()=>{
  const source={id:"snapshot",sourceSha256:"source",catalogSha256:"catalog",tables:[{count:4},{count:7}]};
  const valid={ok:true,allRecordHashesMatch:true,allSourceFileHashesMatch:true,timestampFinancialAndCounterChecksPassed:true,
    comparisonDatabase:"owned loopback restore",sourceSha256:"source",catalogSha256:"catalog",snapshotId:"snapshot",tables:282,records:11,sourceManifestSha256:"inventory",ciphertextSha256:"archive"};
  it("accepts only the exact restored source and archive",()=>expect(()=>requireRestoredSourceProof(valid,source,"inventory","archive")).not.toThrow());
  for(const [key,value] of Object.entries({ok:false,allRecordHashesMatch:false,allSourceFileHashesMatch:false,timestampFinancialAndCounterChecksPassed:false,
    comparisonDatabase:"remote read",sourceSha256:"other",catalogSha256:"other",snapshotId:"other",tables:281,records:10,sourceManifestSha256:"other",ciphertextSha256:"other"})){
    it(`rejects changed ${key}`,()=>expect(()=>requireRestoredSourceProof({...valid,[key]:value},source,"inventory","archive")).toThrow());
  }
  it("rejects missing evidence",()=>expect(()=>requireRestoredSourceProof(undefined,source,"inventory","archive")).toThrow());
});
