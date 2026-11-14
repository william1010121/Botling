// chat.js of the Botling 3 page: the 2.x chat page's entry, unchanged, then the page's media mapping (chat-media.ts),
// which replaces the media source the 2.x entry set. ES modules run in import order, so the second runs after the first.
import "../src/renderer/chat-frame/entry";
import { installChatMedia } from "./chat-media";

installChatMedia();
