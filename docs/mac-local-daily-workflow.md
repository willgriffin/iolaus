# Daily work on the Mac app

Iolaus keeps this workflow in the Mac's local workspace and SQLite database. It does not require hosted Iolaus, an AI account, or employer transmission.

1. Open the installed app, finish owner sign-in, and visit **Profile** (`/admin/onboarding`) to save your name and contact details.
2. Open **Career** (`/admin/career`). Enter experience, education and skills manually. **Upload resume** can read a text PDF locally: review and edit the extracted summary before applying it, then split the facts into the structured Career sections. Local import does not infer structured facts with AI and does not send the PDF to an extractor or OCR service. Scanned PDFs need manual entry; text proposals are bounded to 4,000 characters.
3. Open **Opportunities**, create a job from its title, company, posting text and optional URL, and save it. Capturing a URL is separate from requesting a crawl.
4. Create an application, choose its resume materials, prepare the resume, and download the PDF for your review. This does not submit it to an employer. Exported files are sensitive copies you control.
5. Update the application status and notes. Quit and reopen Iolaus; the same profile, opportunity, prepared materials and status should remain.

PDF export uses `@happyvertical/pdf` and its installed Chromium discovery. Install Google Chrome in `/Applications` and retry if PDF preparation reports that Chromium cannot be found. The desktop WebView itself is not a Chromium PDF engine. An advanced configuration can set `PUPPETEER_EXECUTABLE_PATH` to a compatible installed browser. Resume source and generated artifacts remain in the app's data directory; back up the entire local data directory while Iolaus is stopped.

## Acceptance evidence

The installed-app harness under `apps/site/e2e/desktop-mvp*` drives synthetic data through create and verify phases across an actual app restart. Use its documented commands and a disposable data directory. The test design is [mac-local-workflow-test-matrix.md](mac-local-workflow-test-matrix.md). Do not use real personal data in screenshots or reports.
