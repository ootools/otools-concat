// Native WebKit regression harness. Only starts the sidecar passed by the smoke runner.
import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

final class WebViewSmoke: NSObject, WKURLSchemeHandler, WKScriptMessageHandler {
    var webview: WKWebView!
    let child = Process()
    let input = Pipe()
    let output = Pipe()
    let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    var started = false
    var finished = false
    var lastCheck = "page load"

    func finish(_ code: Int32, _ result: [String: Any]) {
        guard !finished else { return }
        finished = true
        try? input.fileHandleForWriting.close()
        if child.isRunning {
            child.terminate()
            child.waitUntilExit()
        }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) {
            print(line)
        }
        exit(code)
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let html = "<script>window.webkit.messageHandlers.report.postMessage({phase:'origin',origin:location.origin});</script>"
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html",
                                   expectedContentLength: html.utf8.count, textEncodingName: "utf-8"))
        task.didReceive(Data(html.utf8))
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["phase"] as? String == "progress" {
            lastCheck = body["check"] as? String ?? lastCheck
            return
        }
        if body["phase"] as? String != "origin" {
            finish(body["phase"] as? String == "done" ? 0 : 1, body)
            return
        }
        guard !started, let origin = body["origin"] as? String else { return }
        started = true
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
        child.arguments = ["--stdio"]
        child.standardInput = input
        child.standardOutput = output
        child.standardError = FileHandle.standardError
        do {
            try child.run()
            let data = try JSONSerialization.data(withJSONObject: ["type": "init", "token": token, "origin": origin])
            input.fileHandleForWriting.write(data + Data([10]))
        } catch {
            finish(2, ["phase": "error", "message": "sidecar startup: \(error)"])
            return
        }
        DispatchQueue.global().async {
            var buffer = Data()
            while buffer.count < 65536 {
                let chunk = self.output.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                guard let newline = buffer.firstIndex(of: 10) else { continue }
                guard let ready = try? JSONSerialization.jsonObject(with: buffer.prefix(upTo: newline)) as? [String: Any],
                      ready["event"] as? String == "ready", ready["protocol"] as? Int == 1,
                      let port = ready["port"] as? Int, (1...65535).contains(port) else { break }
                DispatchQueue.main.async {
                    do {
                        let client = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
                        let args = try JSONSerialization.data(withJSONObject: ["http://127.0.0.1:\(port)", self.token])
                        let script = client + "\nrunWebviewProbe.apply(null, \(String(data: args, encoding: .utf8)!)); void 0;"
                        self.webview.evaluateJavaScript(script) { _, error in
                            if let error = error {
                                self.finish(3, ["phase": "error", "message": "JavaScript evaluation: \(error)"])
                            }
                        }
                    } catch {
                        self.finish(3, ["phase": "error", "message": "client script: \(error)"])
                    }
                }
                return
            }
            DispatchQueue.main.async {
                self.finish(2, ["phase": "error", "message": "sidecar handshake missing or invalid"])
            }
        }
    }
}

guard CommandLine.arguments.count == 3 else {
    fputs("usage: webview-smoke <concatd> <client-script>\n", stderr)
    exit(2)
}
let smoke = WebViewSmoke()
let config = WKWebViewConfiguration()
config.setURLSchemeHandler(smoke, forURLScheme: "otools-plugin")
config.userContentController.add(smoke, name: "report")
smoke.webview = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: config)
smoke.webview.load(URLRequest(url: URL(string: "otools-plugin://localhost/otools-concat/dist/index.html")!))
DispatchQueue.main.asyncAfter(deadline: .now() + 75) {
    smoke.finish(4, ["phase": "error", "message": "WebKit smoke timed out after: \(smoke.lastCheck)"])
}
app.run()
