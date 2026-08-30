# Seating Plan

A browser-based classroom seating planner, starting with a privacy-first iSAMS importer.

## Stage 1

The current prototype reads iSAMS Set List exports locally in the browser. It supports HTML and MHTML/MHT files and dynamically detects the student fields present in the report.

For MHTML exports it also reads embedded images, so the saved report can contain student photographs without the app making requests back to iSAMS.

### Try it

Open `index.html` in a modern browser, then choose an iSAMS HTML/MHT/MHTML report.

Use **Run self-test** to check the parser without real student data.

### Privacy

The prototype has no server component and no analytics or external data service. Files are processed in the browser. Do not commit real iSAMS exports, student data, or photographs to this repository.

## Roadmap

- [x] Stage 1: HTML/MHTML parsing prototype
- [ ] Robust field and photo matching tests
- [ ] Student/card interface
- [ ] Classroom layout editor
- [ ] Drag-and-drop seating plans
- [ ] Save/load plans locally
- [ ] Printing/export
- [ ] Optional automatic seating generation and constraints
