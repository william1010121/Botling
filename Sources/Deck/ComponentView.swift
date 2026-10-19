import AppKit
import DeckCore
import SwiftUI
import WebKit

/// Draws one component from its HTML template. Taller or shorter as its content needs; redraws
/// when the template file changes.
struct ComponentView: View {
    @ObservedObject var library: ComponentLibrary
    let name: String
    let data: String
    /// The user picked option `index`.
    var onChoose: ((Int) -> Void)?
    /// The user answered in words (or a component that asks nothing sent a reply).
    var onAnswer: ((String) -> Void)?
    @State private var height: CGFloat = 52

    var body: some View {
        if let template = library.template(name) {
            ComponentWebView(
                page: Self.page(template: template, data: data),
                baseURL: library.folder.appending(path: name),
                height: $height,
                onChoose: onChoose,
                onAnswer: onAnswer
            )
            .frame(height: height)
            // Re-read the template when its file changes.
            .id(library.versions[name, default: 0])
        }
    }

    /// The template inside a page that gives it `window.deck` and reports its height.
    static func page(template: String, data: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <style>html,body{margin:0;padding:0;background:transparent;color:#EDEDF0;font:14px -apple-system,"PingFang TC",sans-serif;overflow:hidden}</style>
        <script>
        window.deck = {
          data: \(data),
          // One way to answer: a number picks that option, text is the user's own words.
          answer(value) {
            if (typeof value === 'number') webkit.messageHandlers.deck.postMessage({type: 'answer', index: value});
            else webkit.messageHandlers.deck.postMessage({type: 'answer', text: String(value)});
          },
          choose(index) { this.answer(Number(index)); },
          send(text) { this.answer(String(text)); }
        };
        </script></head><body><div id="deck-root">
        \(template)
        </div><script>
        const deckRoot = document.getElementById('deck-root');
        const deckSize = () => webkit.messageHandlers.deck.postMessage({type: 'size', height: Math.ceil(deckRoot.getBoundingClientRect().height)});
        new ResizeObserver(deckSize).observe(deckRoot);
        window.addEventListener('load', deckSize);
        </script></body></html>
        """
    }
}

private struct ComponentWebView: NSViewRepresentable {
    let page: String
    let baseURL: URL
    @Binding var height: CGFloat
    var onChoose: ((Int) -> Void)?
    var onAnswer: ((String) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "deck")
        let view = PassThroughWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loaded != page {
            context.coordinator.loaded = page
            view.loadHTMLString(page, baseURL: baseURL)
        }
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "deck")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var parent: ComponentWebView?
        var loaded: String?

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "size":
                if let height = body["height"] as? Double, height > 0 { parent?.height = height }
            case "answer":
                if let index = body["index"] as? Int {
                    parent?.onChoose?(index)
                } else if let text = body["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    parent?.onAnswer?(text)
                }
            default:
                break
            }
        }
    }
}

/// Lets the chat scroll when the pointer is over a component.
private final class PassThroughWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        if let outer = enclosingScrollView {
            outer.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }
}

/// A component with its report button beside it, shown on hover: tell the component team what to
/// change, or put back the version before the last change.
struct ReportableComponent<Content: View>: View {
    @ObservedObject var library: ComponentLibrary
    let name: String
    @ViewBuilder var content: Content
    @State private var hovering = false
    @State private var reporting = false
    @State private var request = ""

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            content
            VStack(spacing: 4) {
                if library.working[name] != nil {
                    ProgressView().controlSize(.small).frame(width: 32, height: 32)
                        .accessibilityLabel("組件改版中")
                } else {
                    Button { reporting = true } label: {
                        Image(systemName: "flag")
                            .font(.system(size: 13))
                            .foregroundStyle(reporting ? Theme.blue : Theme.muted)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .opacity(hovering || reporting ? 1 : 0)
                    .accessibilityLabel("回報這個組件")
                    .popover(isPresented: $reporting, arrowEdge: .trailing) { popover }
                }
                if library.updated.contains(name) {
                    Text("已更新").font(.system(size: 11)).foregroundStyle(Theme.green)
                }
            }
            .frame(width: 36)
        }
        .onHover { hovering = $0 }
    }

    private var popover: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("要組件團隊怎麼改？").font(.system(size: 13, weight: .semibold))
            // No Return-to-send here: Return may be confirming an input method's candidate.
            TextField("例如：選項改成橫排", text: $request, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            HStack {
                if library.hasPrevious(name) {
                    Button("退回上一版") {
                        library.revert(name)
                        reporting = false
                    }
                }
                Spacer()
                Button("送出", action: send)
                    .disabled(request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 300)
    }

    private func send() {
        let text = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        library.request(name, change: text, from: "使用者")
        request = ""
        reporting = false
    }
}
