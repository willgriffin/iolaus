import XCTest
final class NativeQA: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    func test10RealEmailSignIn() throws {
        let app = XCUIApplication(bundleIdentifier: "us.jobgeni.app.qa")
        app.launch()
        let login = app.webViews.links["Sign in"].firstMatch
        XCTAssertTrue(login.waitForExistence(timeout: 30), "Hosted root sign-in link")
        login.tap()
        let email = app.webViews.textFields["Email address"].firstMatch
        XCTAssertTrue(email.waitForExistence(timeout: 15), "Hosted magic-link email input")
        email.tap(); email.typeText("mobile-owner@phone-qa.invalid")
        let send = app.webViews.buttons["Email me a sign-in link"].firstMatch
        if !send.isHittable { app.swipeUp() }
        send.tap()
        XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format:"label CONTAINS %@", "If that address is invited")).firstMatch.waitForExistence(timeout: 15))
        var link = ""
        for _ in 0..<20 {
            let received = expectation(description: "isolated mail retrieval")
            URLSession.shared.dataTask(with: URL(string:"http://127.0.0.1:25473/link")!) { data, _, _ in
                if let data { link = String(data:data,encoding:.utf8) ?? "" }
                received.fulfill()
            }.resume()
            wait(for:[received],timeout:5)
            if !link.isEmpty { break }
            Thread.sleep(forTimeInterval:0.25)
        }
        XCTAssertFalse(link.isEmpty, "Actual SMTP message delivered to isolated sink")
        app.buttons["open-sign-in-link"].tap()
        let input = app.alerts.textFields["sign-in-link"]
        XCTAssertTrue(input.waitForExistence(timeout:5))
        input.tap(); input.typeText(link)
        app.alerts.buttons["Open"].tap()
        link = ""
        XCTAssertTrue(app.webViews.staticTexts["Finish signing in"].waitForExistence(timeout:15))
        app.webViews.buttons["Sign in"].tap()
        XCTAssertTrue(app.webViews.buttons["Save private setup"].waitForExistence(timeout:20), "Authenticated onboarding must load after hosted token POST")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name="authenticated-onboarding";shot.lifetime = .keepAlways;add(shot)
    }
    func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<16 {
            if element.isHittable { return }
            app.webViews.firstMatch.swipeUp()
        }
    }
    func test20CreateResumeAndRelaunch() {
        let app = XCUIApplication(bundleIdentifier: "us.jobgeni.app.qa")
        app.launch()
        let workspace=app.webViews.links["Open your workspace"].firstMatch
        XCTAssertTrue(workspace.waitForExistence(timeout:20), "Cookie survives native app relaunch")
        workspace.tap()
        let name=app.webViews.textFields["Display name"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout:20))
        reveal(name,in:app);name.tap();name.typeText("Fictional Mobile Candidate"); if app.toolbars.buttons["Done"].exists { app.toolbars.buttons["Done"].tap() }
        let title=app.webViews.textFields["Professional title"].firstMatch
        reveal(title,in:app);title.tap();title.tap();title.typeText("Fictional Phone Engineer"); if app.toolbars.buttons["Done"].exists { app.toolbars.buttons["Done"].tap() }
        let summary=app.webViews.textViews["Professional summary"].firstMatch
        reveal(summary,in:app);summary.tap();summary.typeText("Synthetic resume created through native phone QA."); if app.toolbars.buttons["Done"].exists { app.toolbars.buttons["Done"].tap() }
        let save=app.webViews.buttons["Save private setup"].firstMatch
        reveal(save,in:app);save.tap()
        XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format:"label CONTAINS %@", "Saved private onboarding data")).firstMatch.waitForExistence(timeout:20))
        app.webViews.buttons["Menu"].firstMatch.tap()
        let resume=app.webViews.links["Resume"].firstMatch
        XCTAssertTrue(resume.waitForExistence(timeout:10));resume.tap()
        XCTAssertTrue(app.webViews.staticTexts["Fictional Mobile Candidate"].firstMatch.waitForExistence(timeout:20))
        let shot=XCTAttachment(screenshot:app.screenshot());shot.name="owned-resume-created";shot.lifetime = .keepAlways;add(shot)
    }

    func openResume(_ app: XCUIApplication, fromRoot: Bool = false) {
        if fromRoot {
            let workspace=app.webViews.links["Open your workspace"].firstMatch
            XCTAssertTrue(workspace.waitForExistence(timeout:20));workspace.tap()
        }
        let menu=app.webViews.buttons["Menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout:20));menu.tap()
        let resume=app.webViews.links["Resume"].firstMatch
        XCTAssertTrue(resume.waitForExistence(timeout:10));resume.tap()
        XCTAssertTrue(app.webViews.buttons["Edit Fictional Mobile Candidate"].firstMatch.waitForExistence(timeout:20))
    }
    func editSummary(_ value: String, in app: XCUIApplication) {
        app.webViews.buttons["Edit Fictional Mobile Candidate"].firstMatch.tap()
        let summary=app.webViews.textViews["Summary"].firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout:10));reveal(summary,in:app);summary.tap()
        summary.tap(withNumberOfTaps:3,numberOfTouches:1)
        summary.typeText(value)
        XCTAssertEqual(summary.value as? String,value,"Replace selected synthetic summary")
        if app.toolbars.buttons["Done"].exists {app.toolbars.buttons["Done"].tap()}
        let save=app.webViews.buttons["Save"].firstMatch;reveal(save,in:app);save.tap()
        XCTAssertTrue(app.webViews.staticTexts["Saved profile and summary."].firstMatch.waitForExistence(timeout:15))
    }
    func anonymousPublic() -> (Int,String) {
        let done=expectation(description:"anonymous public HTTP")
        var result=(0, "")
        let config=URLSessionConfiguration.ephemeral
        URLSession(configuration:config).dataTask(with:URL(string:"https://localhost:34472/people/phone-native-qa-372")!) {data,response,_ in
            result=((response as? HTTPURLResponse)?.statusCode ?? 0,data.flatMap{String(data:$0,encoding:.utf8)} ?? "")
            done.fulfill()
        }.resume();wait(for:[done],timeout:15);return result
    }
    func test30EditPersistPublishWithdraw() {
        let app=XCUIApplication(bundleIdentifier:"us.jobgeni.app.qa");app.launch()
        openResume(app,fromRoot:true)
        editSummary("Synthetic resume edited through native phone QA.",in:app)
        app.terminate();app.launch();openResume(app,fromRoot:true)
        XCTAssertTrue(app.webViews.staticTexts["Synthetic resume edited through native phone QA."].firstMatch.waitForExistence(timeout:15),"Edited resume persists across native relaunch")
        let persisted=XCTAttachment(screenshot:app.screenshot());persisted.name="edited-resume-after-relaunch";persisted.lifetime = .keepAlways;add(persisted)
        let manage=app.webViews.links["Manage public profile"].firstMatch;reveal(manage,in:app);manage.tap()
        let handle=app.webViews.textFields["Public handle"].firstMatch
        XCTAssertTrue(handle.waitForExistence(timeout:15));reveal(handle,in:app);if (handle.value as? String) != "phone-native-qa-372" { handle.tap();handle.typeText("phone-native-qa-372") }
        if app.toolbars.buttons["Done"].exists {app.toolbars.buttons["Done"].tap()}
        let generate=app.webViews.buttons["Generate preview"].firstMatch;reveal(generate,in:app);generate.tap()
        let publish=app.webViews.buttons["Publish this version"].firstMatch
        XCTAssertTrue(publish.waitForExistence(timeout:90),"Real PDF/storage preview prepared")
        reveal(publish,in:app);publish.tap()
        XCTAssertTrue(app.webViews.staticTexts["Published"].firstMatch.waitForExistence(timeout:20))
        let publicResult=anonymousPublic();XCTAssertEqual(publicResult.0,200);XCTAssertTrue(publicResult.1.contains("Fictional Mobile Candidate"));XCTAssertFalse(publicResult.1.contains("mobile-owner@phone-qa.invalid"));XCTAssertTrue(publicResult.1.contains("Synthetic resume edited through native phone QA."))
        let published=XCTAttachment(screenshot:app.screenshot());published.name="selected-resume-published";published.lifetime = .keepAlways;add(published)
        openResume(app);editSummary("PRIVATE MATERIAL must not change the published snapshot.",in:app)
        let unchanged=anonymousPublic();XCTAssertEqual(unchanged.0,200);XCTAssertFalse(unchanged.1.contains("PRIVATE MATERIAL"));XCTAssertTrue(unchanged.1.contains("Synthetic resume edited through native phone QA."))
        let manageAgain=app.webViews.links["Manage public profile"].firstMatch;reveal(manageAgain,in:app);manageAgain.tap()
        let unpublish=app.webViews.buttons["Unpublish profile"].firstMatch
        XCTAssertTrue(unpublish.waitForExistence(timeout:15));reveal(unpublish,in:app);unpublish.tap()
        XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format:"label CONTAINS %@","Your previous public profile is unpublished")).firstMatch.waitForExistence(timeout:15))
        let withdrawn=anonymousPublic();XCTAssertTrue([404,410].contains(withdrawn.0),"Anonymous URL refuses withdrawn resume")
        let ended=XCTAttachment(screenshot:app.screenshot());ended.name="resume-unpublished";ended.lifetime = .keepAlways;add(ended)
        print("QA_PROOF native-edit-relaunch published-anonymous snapshot-private-edit-absent withdrawn-anonymous-denied")
    }

    func test50RevokedSessionReturnsToSignIn() {
        let app=XCUIApplication(bundleIdentifier:"us.jobgeni.app.qa");app.launch()
        let signIn=app.webViews.links["Sign in"].firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout:20),"Revoked real session is not accepted after native relaunch")
        XCTAssertFalse(app.webViews.links["Open your workspace"].exists)
        XCTAssertFalse(app.webViews.staticTexts["Fictional Mobile Candidate"].exists)
        signIn.tap()
        XCTAssertTrue(app.webViews.textFields["Email address"].firstMatch.waitForExistence(timeout:15))
        let shot=XCTAttachment(screenshot:app.screenshot());shot.name="revoked-session-signin";shot.lifetime = .keepAlways;add(shot)
        print("QA_PROOF real-revoked-session-native-reauth-no-private-content")
    }

}
