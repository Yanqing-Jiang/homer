// Local OCR for the document ingestion pipeline (src/memory/document-extract.ts).
//
// Why a Swift file and not a node package: Vision's VNRecognizeTextRequest is
// the only accurate OCR engine already present on this host, and the whole
// point of the pipeline is that no document bytes leave the machine. Shelling
// out to a tiny compiled binary keeps the image in-process on the Mac.
//
// Usage:  vision-ocr <image-path> [<image-path> ...]
// Output: recognized text on stdout, pages separated by a form feed (\u{0C}).
// Exit 0 on success (including "no text found" -> empty output), 1 on failure
// with a one-line reason on stderr.

import Foundation
import Vision
import CoreGraphics
import ImageIO

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("vision-ocr: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

func loadImage(_ path: String) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else {
        return nil
    }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // Vision resolves these against the installed language assets; unavailable
    // ones are ignored rather than failing the request.
    request.recognitionLanguages = ["en-US", "zh-Hans"]

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    guard let observations = request.results else { return "" }
    var lines: [String] = []
    for observation in observations {
        if let candidate = observation.topCandidates(1).first {
            lines.append(candidate.string)
        }
    }
    return lines.joined(separator: "\n")
}

let paths = Array(CommandLine.arguments.dropFirst())
if paths.isEmpty {
    fail("usage: vision-ocr <image-path> [<image-path> ...]")
}

var pages: [String] = []
for path in paths {
    guard let image = loadImage(path) else {
        fail("cannot decode image: \(path)")
    }
    do {
        pages.append(try recognize(image))
    } catch {
        fail("recognition failed for \(path): \(error.localizedDescription)")
    }
}

FileHandle.standardOutput.write(pages.joined(separator: "\u{0C}").data(using: .utf8)!)
