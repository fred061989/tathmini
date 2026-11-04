# Third-party libraries

Served from Tathmini's own site (not a CDN), so no outside code runs in the app.

| File | Library | Version | Licence |
|---|---|---|---|
| `supabase.js` | @supabase/supabase-js (UMD build) | 2.118.0 | MIT |
| `xlsx.full.min.js` | SheetJS Community Edition | 0.18.5 | Apache-2.0 |
| `html2canvas.min.js` | html2canvas | 1.4.1 | MIT |
| `jspdf.umd.min.js` | jsPDF | 2.5.1 | MIT |
| `jszip.min.js` | JSZip | 3.10.1 | MIT (dual MIT / GPL-3.0) |

To update one, copy the same file from the package's `dist/` folder after `npm install <package>@<version>`, and update this table.
