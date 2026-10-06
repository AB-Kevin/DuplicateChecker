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
| Inbox folder | The folder the app watches. |
| Output folder | Holds Database.xlsx, Duplicates.xlsx, `Processed/` and `Backups/`. |
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

## Good to know

- **Close Database.xlsx and Duplicates.xlsx in Excel before saving decisions.** If one is open, the app says so and keeps your decisions until you try again. Nothing is half-saved.
- **You can edit Database.xlsx in Excel.** The app re-reads it whenever it changes. Keep the `Date Added`, `Source File` and `Source Row` columns; retention relies on `Date Added`.
- **Backups:** the first time each day that Database.xlsx or Duplicates.xlsx is changed, the previous version is copied to `Backups/`. The last 30 days are kept.
- **The same file twice:** if a file identical to one already imported is dropped in again, it is skipped and moved to `Processed`.
- **Correlated columns:** if two compare columns usually move together (for example a procedure code and its standard charge), "3 of 4" behaves more like "2 of 3". Choose columns that each say something different about the entry.
- Only the first worksheet of each file is read, and its first non-blank row is treated as the header row.
- Columns with neither a header nor any data are ignored, such as columns that are formatted but empty past the last real column. A column with data but no header is kept and named by its letter, for example `Column V`.
- Review decisions and the activity log are stored in the app's profile folder (`%APPDATA%\Duplicate Checker`). Settings are stored there too.
- The app has to be running to watch the inbox. Only one copy can run at a time.

## Development

Requires Node.js 20 or later.

```bash
npm install     # also downloads the Electron binary
npm start       # run the app
npm test        # matching and import tests
npm run dist    # build a Windows installer into dist/
```

| Path | Contents |
| --- | --- |
| `src/main/main.js` | Electron main process: window, IPC, wiring |
| `src/main/processor.js` | Importing a file and applying review decisions |
| `src/main/books.js` | Database.xlsx / Duplicates.xlsx, retention, backups |
| `src/main/spreadsheet.js` | Reading and writing spreadsheets (SheetJS) |
| `src/main/inbox.js` | Inbox folder watcher |
| `src/main/settings.js` | Settings defaults and validation |
| `src/shared/matcher.js` | Value normalization and the match index (also used by the review screen) |
| `src/preload/preload.js` | The API exposed to the page |
| `src/renderer/` | The interface |
