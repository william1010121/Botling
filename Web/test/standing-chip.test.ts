// @vitest-environment jsdom
// A standing chip of the input box (composer.chips with `standing`): the 「回覆到 <card>」 mark. It is not sent, is no reason to send an empty box,
// stays after a send, and puts its prefix before the words (not before a slash command). A chip that is not standing still goes after the
// words and is taken away when sent.
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { Composer, type ComposerChip } from "../src/composer";
import type { ChatState } from "../src/types";

let composer: Composer;
const state = { botID: "B1", botName: "B1", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components: {} } as unknown as ChatState;
const sends = () => sent.filter((action) => action.type === "send").map((action) => (action as { text: string }).text);
const standing = (prefix: string): ComposerChip => ({ standing: true, prefix: () => prefix, serialize: () => "", render: () => document.createElement("span") });
const plain = (text: string): ComposerChip => ({ serialize: () => text, render: () => document.createElement("span") });

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
  const slot = document.createElement("div");
  document.body.append(slot);
  composer = new Composer(slot);
  composer.update(state);
});

describe("a standing chip", () => {
  it("puts its prefix before the words, and stays after the send", () => {
    composer.addChip(standing("@p-0001 "));
    composer.setText("先停一下");
    composer.submit();
    expect(sends()).toEqual(["@p-0001 先停一下"]);
    expect(composer.chipsHere()).toHaveLength(1);
    composer.setText("再一句");
    composer.submit();
    expect(sends()).toEqual(["@p-0001 先停一下", "@p-0001 再一句"]);
  });

  it("is no reason to send an empty box: nothing goes with no words, and the send button stays off", () => {
    composer.addChip(standing("@p-0001 "));
    composer.setText("   ");
    composer.submit();
    expect(sends()).toEqual([]);
    expect(composer.root.querySelector<HTMLButtonElement>(".send")?.disabled ?? true).toBe(true);
  });

  it("leaves a slash command alone", () => {
    composer.addChip(standing("@p-0001 "));
    composer.setText("/help");
    composer.submit();
    expect(sends()).toEqual(["/help"]);
  });

  it("goes when it is removed, and then the words go as typed", () => {
    const handle = composer.addChip(standing("@p-0001 "));
    handle.remove();
    composer.setText("hello");
    composer.submit();
    expect(sends()).toEqual(["hello"]);
  });

  it("a chip that is not standing still goes after the words and is taken away, beside a standing one", () => {
    composer.addChip(standing("@p-0001 "));
    composer.addChip(plain("[file]"));
    composer.setText("look");
    composer.submit();
    expect(sends()).toEqual(["@p-0001 look\n\n[file]"]);
    expect(composer.chipsHere()).toHaveLength(1);
  });

  it("a chip that is not standing still lets an empty box send it", () => {
    composer.addChip(plain("[file]"));
    composer.submit();
    expect(sends()).toEqual(["[file]"]);
  });
});
