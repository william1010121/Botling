import Foundation

/// The limits and tables the chat page must agree on with Swift, written once here and exported
/// to `Web/src/contract.json` (the page bundles it). `WebContractTests` fails when the file is
/// out of date; `CCB_WRITE_WEB_CONTRACT=1 swift test --filter WebContractTests` writes it.
public enum WebContract {
    struct Contract: Encodable {
        struct Board: Encodable {
            /// The most cells a Board card spans each way.
            var maxColumns: Int
            var maxRows: Int
            /// Every size ("3x2") to the named size a template sees in `ccb.size.name`.
            var sizeNames: [String: String]
        }

        struct Floating: Encodable {
            /// A floating card's width and height bounds, in points.
            var widths: [Int]
            var heights: [Int]
            /// The most floating cards one chat shows.
            var max: Int
        }

        struct Refresh: Encodable {
            /// A pin's custom interval, in seconds.
            var minSeconds: Int
            var maxSeconds: Int
            /// What a pin refreshed every so often starts at.
            var defaultMinutes: Int
        }

        struct Mention: Encodable {
            /// Besides whitespace and non-ASCII text: what a `/name` may follow.
            var startsAfter: String
            /// Besides ASCII letters and digits: what a name is made of (anything else ends it).
            var nameCharacters: String
        }

        var board: Board
        var floating: Floating
        /// The heights an opened pin's panel may be dragged to.
        var panelHeights: [Int]
        var refresh: Refresh
        /// The most `ccb.save` keeps, in UTF-16 code units of JSON.
        var saveLimit: Int
        /// Picture extensions the lightbox opens.
        var imageExtensions: [String]
        var componentMention: Mention
    }

    static var contract: Contract {
        typealias Size = PinnedComponent.Size
        let floating = PinnedComponent.Floating.self
        return Contract(
            board: .init(maxColumns: Size.maxColumns, maxRows: Size.maxRows,
                         sizeNames: Dictionary(uniqueKeysWithValues: Size.all.map { ($0.rawValue, $0.name) })),
            floating: .init(widths: [floating.widths.lowerBound, floating.widths.upperBound],
                            heights: [floating.heights.lowerBound, floating.heights.upperBound], max: Pins.maxFloating),
            panelHeights: [PinnedComponent.panelHeights.lowerBound, PinnedComponent.panelHeights.upperBound],
            refresh: .init(minSeconds: PinnedComponent.minimumSeconds, maxSeconds: PinnedComponent.maximumSeconds,
                           defaultMinutes: PinnedComponent.defaultMinutes),
            saveLimit: ComponentState.limit,
            imageExtensions: ImageFile.extensions.sorted(),
            componentMention: .init(startsAfter: ComponentMentions.startsAfter, nameCharacters: ComponentMentions.nameCharacters)
        )
    }

    /// The file's text: pretty, keys sorted, ending in a newline.
    public static var json: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return String(decoding: (try? encoder.encode(contract)) ?? Data("{}".utf8), as: UTF8.self) + "\n"
    }
}
