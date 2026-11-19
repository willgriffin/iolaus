import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// A user may paste the emailed URL explicitly so its existing confirmation
// and POST run in this WebView's cookie jar. Never read the clipboard implicitly.
@objc(JobGeniusViewController)
class JobGeniusViewController: CAPBridgeViewController {
    private let signInButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
        let content = UIView(frame: view.bounds)
        content.backgroundColor = .systemBackground
        if let webView { content.addSubview(webView) }
        view = content
        signInButton.setTitle("Open sign-in link", for: .normal)
        signInButton.accessibilityIdentifier = "open-sign-in-link"
        signInButton.addTarget(self, action: #selector(openSignInLink), for: .touchUpInside)
        view.addSubview(signInButton)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top
        signInButton.frame = CGRect(x: 16, y: top, width: view.bounds.width - 32, height: 44)
        webView?.frame = CGRect(x: 0, y: top + 44, width: view.bounds.width,
                               height: max(0, view.bounds.height - top - 44 - view.safeAreaInsets.bottom))
    }

    @objc private func openSignInLink() {
        let prompt = UIAlertController(title: "Open your sign-in link", message: "Copy the link from your JobGenius email, then paste it here. You will confirm sign-in on JobGenius.", preferredStyle: .alert)
        prompt.addTextField { field in
            field.placeholder = "https://jobgeni.us/auth/magic-link?..."
            field.textContentType = .none
            field.autocorrectionType = .no
            field.autocapitalizationType = .none
            field.keyboardType = .URL
            field.accessibilityIdentifier = "sign-in-link"
        }
        prompt.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        prompt.addAction(UIAlertAction(title: "Open", style: .default) { [weak self, weak prompt] _ in
            let input = prompt?.textFields?.first?.text ?? ""
            prompt?.textFields?.first?.text = ""
            #if DEBUG
            let origin = self?.bridge?.config.serverURL ?? URL(string: "https://jobgeni.us")!
            #else
            let origin = URL(string: "https://jobgeni.us")!
            #endif
            guard let url = SignInLink.destination(input, origin: origin) else {
                let error = UIAlertController(title: "Use a JobGenius sign-in link", message: "Paste the HTTPS sign-in link from your JobGenius email.", preferredStyle: .alert)
                error.addAction(UIAlertAction(title: "OK", style: .default))
                self?.present(error, animated: true)
                return
            }
            self?.webView?.load(URLRequest(url: url))
        })
        present(prompt, animated: true)
    }
}
