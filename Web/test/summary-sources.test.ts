import { describe, expect, it } from "vitest";
import type { CatchUpView, MessageView } from "../src/types";
import { citedBullet, summaryMessages, sourceTexts } from "../src/summary-sources";
const message = (id: string, text: string): MessageView => ({ id, text, role: "bot", stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false });
const source = [message("A", "The exact sentence. Next sentence."), message("B", "The exact sentence.")];
describe("summary source provenance", () => {
  it("bounds references to actual messages in the exact range, in original order", () => {
    expect(summaryMessages({ids:["b","a","missing","a"]} as CatchUpView, [...source, source[0], message("outside", "outside")]).map(m => m.id)).toEqual(["A", "B"]);
    expect(citedBullet("Done [[source:outside]] [[source:missing]]", source)).toEqual({text:"Done",sources:[]});
  });
  it("resolves duplicates predictably, including distinct quotes on one message", () => {
    expect(citedBullet("Done [[source:a|The exact sentence.]] [[source:A|The exact sentence.]] [[source:A|Next sentence.]] [[source:B]]", source)).toEqual({text:"Done",sources:[{messageID:"A",quote:"The exact sentence."},{messageID:"A",quote:"Next sentence."},{messageID:"B"}]});
  });
  it("never borrows another message's quote", () => {
    expect(citedBullet("Done [[source:B|Next sentence.]]", source).sources).toEqual([{messageID:"B"}]);
  });
  it("recognizes options and notes without joining fields or executing component data", () => {
    const card = {...source[0], choices:[{label:"Ship",detail:"After review",recommended:true}],answer:"Wait for tests", displays:[{name:"choices",data:'{"options":[{"label":"Linux"}],"chosen":[0],"notes":"Check signing"}',command:"touch /tmp/never"}]};
    expect(sourceTexts(card)).toContain("Check signing");
    expect(citedBullet("Decision [[source:A|ShipAfter review]] [[source:A|Wait for tests]] [[source:A|Linux]]", [card]).sources).toEqual([{messageID:"A"},{messageID:"A",quote:"Wait for tests"},{messageID:"A",quote:"Linux"}]);
  });
  it("keeps historical plain bullets without invented citations", () => {
    expect(citedBullet("Old summary", source)).toEqual({text:"Old summary",sources:[]});
  });
});

it("attributes a real selection or note to the user only with explicit validated answer provenance", () => {
  const card = {...source[0], choices:[{label:"Stable",detail:null,recommended:true}], chosen:0, answer:"Review first"};
  expect(citedBullet("Decision [[source:A/answer|Stable]] [[source:A/answer|Review first]]",[card]).sources).toEqual([{messageID:"A",quote:"Stable",part:"answer"},{messageID:"A",quote:"Review first",part:"answer"}]);
  expect(citedBullet("Decision [[source:A/answer|Stable]]",source).sources).toEqual([]);
});

it("preserves exact quotes containing single square brackets",()=>{
 expect(citedBullet("Done [[source:A|Read [the source] first.]]",[{...source[0],text:"Read [the source] first."}]).sources).toEqual([{messageID:"A",quote:"Read [the source] first."}]);
});


it("labels source records without author metadata honestly without inventing an author", async () => {
  const { sourceAuthor } = await import("../src/summary-viewer");
  expect(sourceAuthor({...source[0],role:"notice"})).toBe("Original conversation");
  expect(sourceAuthor({...source[0],sourceAuthor:"Garden",sourceEngine:"codex"})).toBe("Garden · Codex");
});
