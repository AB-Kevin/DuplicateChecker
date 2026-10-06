# Duplicate Checker

A desktop app that watches an inbox folder for spreadsheets, flags rows that look like duplicates, and lets you review them. Rows you confirm as duplicates go to **Duplicates.xlsx**. Everything else is added to **Database.xlsx**, a running database that each new file is checked against.

## How it works

1. **Drop a spreadsheet into the inbox folder** (.xlsx, .xls, .xlsm, .csv or .ods). You can also drag files onto the app window, or use **Activity → Add files to inbox**.
2. **The app compares each row** against:
   - every entry in Database.xlsx that is still inside the retention period,
   - rows from earlier files that are still waiting for review, and
   - earlier rows in the same file.

   A row is flagged when every column in the **must always match** list matches, and at least *N* of the columns in the **some must match** list match too. For example: flag when PatientName and Service Date match, and at least 2 of Member ID, CPT Code and Charge Amount match. Either list can be empty.
3. **Rows that match nothing go straight into Database.xlsx.** Flagged rows wait on the **Review** screen.
4. **On the Review screen**, each flagged row appears beside the entries it matched. Matching cells are shaded. Mark each row **Duplicate** (`D`) or **Not a duplicate** (`N`), then click **Save decisions** (`Ctrl+S`).
   - Duplicates are appended to Duplicates.xlsx, along with what they matched and on which columns.
   - Rows that are not duplicates are appended to Database.xlsx.
5. **The imported file is moved** to the `Processed` folder.

Files already in the inbox when the app starts are picked up then, so nothing is missed while the app is closed.

## Settings

| Setting | What it does |
| --- | --- |
| Data folder | Holds everything the app keeps; see [The data folder](#the-data-folder). |
| Inbox folder | The folder the host watches. By default the `Inbox` folder inside the data folder, in which case it moves when the data folder does. |
| Your name | Shown to others using the same data folder. |
| This computer is the host | See [Reviewing together](#reviewing-together). |
| Columns that must always match | Every column checked here has to match for a row to be flagged. |
| Columns where some must match | At least *N* of the columns checked here also have to match. A column can be in only one of the two lists. Columns from files you've dropped in are listed automatically; you can also read them from a spreadsheet or type them. The **Current rule** box spells out the combined rule. |
| Keep database entries for *N* days | Entries older than this are removed from Database.xlsx at the next import or save, and new files are no longer compared against them. `0` keeps entries indefinitely. |
| Clear all data | Empties Database.xlsx and Duplicates.xlsx, removes every entry waiting for review, and clears the activity log so the same files can be imported again. You must type `Clear ALL DATA` (capitals matter) to confirm. Both spreadsheets are copied to `Backups/` first. Settings, the inbox and `Processed/` are not changed. |

### How values are compared

- Text is compared without regard to capitals or extra spaces (`John  SMITH` = `john smith`).
- Dates are compared by date: `3/15/2026`, `03/15/26`, `2026-03-15` and `15-Mar-2026` are all equal. Numeric dates are read month first.
- Numbers and amounts are compared by value: `$1,250.00` = `1250`, and `00123` = `123`.
- Blank cells never count as a match.
- Column names are matched without regard to capitals or spacing, so `Patient Name` in one file lines up with `patient name` in another.

If a file is missing a column from the **must always match** list, it stays in the inbox and the Activity screen explains why. If it is missing some of the **some must match** columns, it is checked on the ones it has, as long as at least *N* are present.

## The data folder

Everything the app keeps is in one folder, chosen under **Settings → Data folder**:

| In the data folder | What it is |
| --- | --- |
| `Database.xlsx` | Every entry that isn't a duplicate, within the retention period |
| `Duplicates.xlsx` | Entries confirmed as duplicates |
| `App data/review-state.json` | Entries waiting for review, the activity log, and recently saved decisions |
| `App data/people/` | One file per person: who they are, what they have open, and their decisions |
| `App data/settings.json` | The matching rules and retention period |
| `Processed/` | Imported files |
| `Backups/` | Daily copies of the two spreadsheets |
| `Inbox/` | The default inbox |

Each computer only remembers where the data folder and the inbox are, your name, and whether it is the host.

**Moving to OneDrive or handing it off.** Choose a folder in OneDrive as the data folder and save. If the new folder is empty, the app offers to copy everything there; the old folder is left as it was, so you can delete it once you've checked the new one. To hand the work to someone else, share the OneDrive folder with them. They install the app and choose the same folder as their data folder. The app recognizes it and switches to it, including its matching settings, its database and the entries waiting for review.

## Reviewing together

Several people can review at the same time from one shared data folder.

- **One computer is the host.** It imports new files from the inbox and saves everyone's decisions to Database.xlsx and Duplicates.xlsx. Turn this on under **Settings → Sharing → This computer is the host**. A new install starts as host; someone who switches to a folder another computer is already hosting joins as a reviewer.
- **Everyone else reviews.** Their decisions go to the host with **Send decisions**, and the host saves them within a few seconds of OneDrive syncing. Reviewers see the matching settings but only the host can change them, or clear all data.
- **You can see each other.** Each entry shows who else has it open and any decision someone has made but not sent. The Activity screen lists everyone using the folder.
- **First sent wins.** Once someone sends a decision for an entry, it is settled for everyone. If two people send different decisions before seeing each other's, the first one sent is used, and the other person is told.
- **The host's app has to be open** for decisions to be saved. Until it is, sent decisions wait safely, and a banner says so.
- **Two hosts.** If two computers are set as host, the one that has been host longer keeps the job and the other waits, with a banner on both. When the acting host closes its app, the waiting one takes over.

How it works: every file has one writer, so OneDrive never has to merge two people's changes. Each person's copy of the app writes only its own file in `App data/people/`; the host writes everything else. Changes appear on the other computers as fast as OneDrive syncs them, usually within seconds. "First sent" goes by each computer's clock, so keep Windows' automatic time setting on.

To hand the work to someone else for good, share the folder with them. They make their computer the host, or it becomes host on its own once yours is closed.

## Good to know

- **Close Database.xlsx and Duplicates.xlsx in Excel before saving decisions.** If one is open, the app says so and keeps your decisions until you try again. Nothing is half-saved.
- **You can edit Database.xlsx in Excel.** The app re-reads it whenever it changes. Keep the `Date Added`, `Source File` and `Source Row` columns; retention relies on `Date Added`.
- **Backups:** the first time each day that Database.xlsx or Duplicates.xlsx is changed, the previous version is copied to `Backups/`. The last 30 days are kept.
- **The same file twice:** if a file identical to one already imported is dropped in again, it is skipped and moved to `Processed`.
- **Correlated columns:** if two compare columns usually move together (for example a procedure code and its standard charge), "3 of 4" behaves more like "2 of 3". Choose columns that each say something different about the entry.
- Only the first worksheet of each file is read, and its first non-blank row is treated as the header row.
- Columns with neither a header nor any data are ignored, such as columns that are formatted but empty past the last real column. A column with data but no header is kept and named by its letter, for example `Column V`.
- Only the folder locations, your name and whether this computer is the host are stored on each computer (in `%APPDATA%\Duplicate Checker`). Everything else is in the data folder.
- The host's app has to be running to import files from the inbox. Only one copy of the app can run on each computer.

## Development

Requires Node.js 20 or later.

```bash
npm install     # also downloads the Electron binary
npm start       # run the app
npm test        # matching and import tests
npm run dist    # build a Windows installer into dist/
```

### Releasing

Pushing a version tag builds the Windows installer on GitHub and publishes it as a release (`.github/workflows/release.yml`). Once your changes are committed:

```bash
npm version patch   # or minor / major: runs the tests, bumps the version, commits, and tags vX.Y.Z
git push            # or Push origin in GitHub Desktop; the new tag goes with it
```

The release appears on the repository's **Releases** page a few minutes later as `DuplicateChecker-Setup-X.Y.Z.exe`, with notes listing the changes since the previous release. Follow the build under the **Actions** tab. The build stops without publishing if the tag doesn't match the version in package.json or a test fails.

- `npm version` stops without changing anything if there are uncommitted changes or a test fails.
- This clone pushes tags with commits because `push.followTags` is set in its `.git/config`. That setting isn't part of the repository, so in any new clone run `git config push.followTags true` once, or push with `git push --follow-tags`.
- The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time it runs. Choose **More info**, then **Run anyway**.
- To build the installer locally instead, run `npm run dist`. It is written to `dist/`.

### Dependencies

Dependabot (`.github/dependabot.yml`) checks the npm dependencies every Monday. Minor and patch updates come as one pull request; each major update gets its own.

SheetJS (`xlsx`) is the exception. It is installed from cdn.sheetjs.com because the npm registry copy is outdated and has known vulnerabilities, so Dependabot skips it. To update it, check [cdn.sheetjs.com](https://cdn.sheetjs.com) for the latest version and run:

```bash
npm install https://cdn.sheetjs.com/xlsx-X.Y.Z/xlsx-X.Y.Z.tgz
```

### Layout

| Path | Contents |
| --- | --- |
| `src/main/main.js` | Electron main process: window, IPC, wiring |
| `src/main/processor.js` | Importing a file and applying review decisions |
| `src/main/books.js` | Database.xlsx / Duplicates.xlsx, retention, backups |
| `src/main/spreadsheet.js` | Reading and writing spreadsheets (SheetJS) |
| `src/main/inbox.js` | Inbox folder watcher |
| `src/main/settings.js` | Settings defaults, validation, loading and saving |
| `src/main/datafolder.js` | Data folder layout: copying, summarizing, moving data from earlier versions |
| `src/main/team.js` | Reviewing together: people files, choosing the host, saving sent decisions |
| `src/main/jsonfile.js` | Reading and writing JSON files safely |
| `src/shared/matcher.js` | Value normalization and the match index (also used by the review screen) |
| `src/preload/preload.js` | The API exposed to the page |
| `src/renderer/` | The interface |
| `build/icon.png` | App and installer icon |
| `.github/workflows/release.yml` | Builds and publishes a release when a version tag is pushed |
| `.github/dependabot.yml` | Weekly dependency update checks |
