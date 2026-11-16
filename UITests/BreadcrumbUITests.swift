import XCTest
import AVFoundation

final class BreadcrumbUITests: XCTestCase {
    @MainActor func testActivityInsights() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.rewind.local")
        app.launchArguments = ["--demo"]
        app.launch()
        defer { app.terminate() }
        let item = app.descendants(matching: .statusItem).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        item.click()
        XCTAssertTrue(app.buttons["Save last hour"].waitForExistence(timeout: 10))
        app.radioButtons["Saved"].hover()
        app.radioButtons["Activity"].click()
        XCTAssertEqual(app.staticTexts["insights-sample-count"].value as? String, "12")
        let coding = app.descendants(matching: .any)["insights-row-Coding"]
        XCTAssertTrue(coding.waitForExistence(timeout: 5))
        XCTAssertTrue((coding.value as? String ?? coding.label).contains("8 captures"))
        capture("insights-activities", app: app)
        app.radioButtons["Activities"].hover()
        app.radioButtons["Apps"].click()
        let xcode = app.descendants(matching: .any)["insights-row-Xcode"]
        XCTAssertTrue(xcode.waitForExistence(timeout: 5))
        XCTAssertTrue((xcode.value as? String ?? xcode.label).contains("8 captures"))
        capture("insights-apps", app: app)
        app.buttons["Review labels"].click()
        app.scrollViews.firstMatch.scroll(byDeltaX: 0, deltaY: -1000)
        expand("Labels & details", app: app)
        let correction = app.menuButtons["Correct label"]
        XCTAssertTrue(correction.waitForExistence(timeout: 5))
        correction.click()
        app.menuItems["Other apps"].click()
        app.radioButtons["Activity"].click()
        app.scrollViews.firstMatch.scroll(byDeltaX: 0, deltaY: 2000)
        XCTAssertTrue(app.staticTexts["Based on app and page context · 1 corrected"].waitForExistence(timeout: 5))
        let unknown = app.descendants(matching: .any)["insights-row-Other apps"]
        XCTAssertTrue(unknown.waitForExistence(timeout: 5))
        XCTAssertTrue((unknown.value as? String ?? unknown.label).contains("1 capture"))
        capture("insights-corrected", app: app)
    }

    @MainActor func testMenuBarClipWorkflow() async throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.rewind.local")
        app.launchArguments = ["--demo"]
        app.launch()
        defer { app.terminate() }
        let item = app.descendants(matching: .statusItem).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        item.click()
        XCTAssertTrue(app.buttons["Save last hour"].waitForExistence(timeout: 10))
        capture("now", app: app)
        app.buttons["Save last hour"].hover()
        app.buttons["Save last hour"].click()
        app.radioButtons["History"].hover()
        app.radioButtons["Saved"].click()
        XCTAssertTrue(app.buttons["Export MP4"].waitForExistence(timeout: 5))
        capture("saved", app: app)
        app.radioButtons["History"].click()
        XCTAssertTrue(app.sliders.firstMatch.waitForExistence(timeout: 5))
        app.sliders.firstMatch.adjust(toNormalizedSliderPosition: 0.8)
        capture("timeline", app: app)
        app.scrollViews.firstMatch.scroll(byDeltaX: 0, deltaY: -1000)
        expand("Save a time range", app: app)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.textFields["Clip name"].isHittable
        }, object: nil)], timeout: 5)
        capture("timeline-details", app: app)
        app.buttons["Settings"].click()
        app.scrollViews.firstMatch.scroll(byDeltaX: 0, deltaY: 2000)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.staticTexts["Capture & privacy"].isHittable
        }, object: nil)], timeout: 5)
        XCTAssertTrue(app.staticTexts["Capture & privacy"].waitForExistence(timeout: 5))
        capture("settings", app: app)
        app.buttons["Back to history"].click()
        app.radioButtons["Saved"].click()
        app.buttons["Export MP4"].click()
        let save = app.dialogs["save-panel"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        app.typeKey("g", modifierFlags: [.command, .shift])
        let go = app.dialogs.sheets.firstMatch
        XCTAssertTrue(go.waitForExistence(timeout: 5))
        go.textFields["PathTextField"].typeText("/tmp")
        app.typeKey(.return, modifierFlags: [])
        let filename = save.textFields["saveAsNameTextField"]
        filename.click()
        filename.typeKey("a", modifierFlags: .command)
        let name = "Breadcrumb-UI-\(UUID()).mp4"
        filename.typeText(name)
        save.buttons["Save"].click()
        let exported = URL(fileURLWithPath: "/tmp").appendingPathComponent(name)
        defer { try? FileManager.default.removeItem(at: exported) }
        let exists = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            FileManager.default.fileExists(atPath: exported.path)
        }, object: nil)
        await fulfillment(of: [exists], timeout: 20)
        let asset = AVURLAsset(url: exported)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let size = try await XCTUnwrap(tracks.first).load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 1440, height: 960))
        let duration = try await asset.load(.duration)
        XCTAssertEqual(duration.seconds, 0.25, accuracy: 0.01)
        item.click()
        app.buttons["Delete Last hour"].click()
        capture("delete-confirmation", app: app)
        app.buttons["Delete clip"].click()
        XCTAssertTrue(app.staticTexts["No saved moments"].waitForExistence(timeout: 5))
        app.buttons["Settings"].click()
        app.scrollViews.firstMatch.scroll(byDeltaX: 0, deltaY: -500)
        app.buttons["Delete the last hour…"].click()
        app.scrollViews.firstMatch.scroll(byDeltaX: 0, deltaY: -1000)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["Delete captures & pause"].isHittable
        }, object: nil)], timeout: 5)
        capture("privacy-deletion", app: app)
        app.buttons["Delete captures & pause"].click()
        app.buttons["Back to history"].click()
        XCTAssertTrue(app.staticTexts["9 captures · stored on this Mac"].waitForExistence(timeout: 5))
    }

    @MainActor private func expand(_ title: String, app: XCUIApplication) {
        let triangle = app.disclosureTriangles[title]
        if triangle.exists { triangle.click() } else { app.buttons[title].click() }
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let image = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
