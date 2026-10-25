# CI Diet settings tabs design QA

Date: 2026-10-25 (Asia/Seoul)

## Target and evidence

- Selected reference: focused-tabs concept, first displayed option. Local source:
  `C:/Users/cherr/.codex/generated_images/01a15a0c-1530-7002-acfb-339f6347c279/exec-da50eaca-916b-4200-a0bd-c73216bbc0f7.png`.
- Implementation: real DSH 0.2.1-rc.2, local-linked `ci-diet-e2e` profile.
- Captures in `.tmp/settings-tabs/`: `dark-general.png`, `light-general.png`,
  `light-small-storage.png`, `dark-small-general.png`, `final-dark-general.png`.
  Captures are local verification artifacts, intentionally excluded from Git.
- Reference and implementation were opened together for visual comparison.
  The generated reference depicts the settings shell filling the image; the
  implementation runs inside DSH's existing modal. Compare CI Diet's content,
  not the surrounding browser/session shell. The host's modal, sidebar, fonts,
  theme accent and installed-plugin list are preserved intentionally.
- Responsive overrides: 1296 x 816 and 600 x 700. Browser zoom was 90%, so
  the desktop CSS viewport reported 1440 x 907 with devicePixelRatio 0.9;
  screenshot pixels are not one CSS pixel. The temporary override was reset.

## Findings and fixes

- [P2, fixed] A 360px directory input wrapped at the host's 564px content
  width, unnecessarily extending General. Reduced desktop input to 260px and
  General row padding to 14px. Narrow containers use full-width inputs.
- [P2, fixed] The inverse-label token made the enabled switch thumb dark in
  the dark theme. The thumb now uses the host's primary brand token; both
  themes were captured again.
- No unresolved P0/P1/P2 findings in CI Diet's settings flow.

## Required fidelity surfaces

- Typography: host font inherited; 22px page title, 15px field labels and
  13px supporting copy establish the reference's hierarchy without replacing
  DSH's font scale. Long rule labels wrap instead of being truncated.
- Layout: five underlined tabs, flat separated rows, three explained switches,
  directory field and scope note. Header/tabs stay above the scrolling body;
  the opaque footer is a separate flex sibling. No fixed/sticky overlay.
- Colors: all colors come from DSH theme aliases. The host's blue accent
  replaces the mock's mint intentionally; light sections remain light.
- Assets: no custom image assets are needed. The existing DSH sidebar icons
  and chrome are retained; no new illustration or logo is introduced.
- Copy: the same control groups as the selected design, localized in all six
  languages. The local-apply explanation still requires review and approval.
  Help expands the existing scope/application explanations instead of linking
  to a fabricated destination. Directory is directly editable without a
  redundant Change button. No savings figures are invented.

## Interaction and regression checks

- All five tabs are reachable, with one visible labelled tabpanel at a time.
- Arrow keys wrap; Home/End select and focus the appropriate tab (unit tests).
- Edits across history/storage survive tab switching and form a single batch
  against the original revision. Rejected conflicting saves retain the draft;
  Discard restores current host values (unit tests).
- Real profile: change lookback 7 -> 8, switch tabs and back, save, verify the
  patch layer contains 8; stage reset, save, verify the override is removed
  and the displayed value returns to 7. Profile theme restored to dark.
- Real profile: enter 31 days, leave History, save; History opens with the
  localized maximum-30 validation error. Discard removes the invalid draft.
- Small light viewport: last storage input bottom 594.99 CSS px; body bottom
  627.39 equals footer top 627.39. Footer width equals page width 382.67px.
  Last input is fully accessible above the footer; no document overflow.
- Client suite: 20/20 passed, including three new tab/validation/keyboard tests.
  Typecheck, lint and build passed. No engine/contract behavior changed, so
  unrelated full engine and remote CI runs were not repeated.
- Console: host account-settings plugin logs `account read failed`; no CI Diet
  rendering error was observed. This host account issue is outside this change.

## Follow-up polish

- Small windows deliberately scroll the body; General need not fit vertically.
- Exact generated-image shell dimensions are not imposed on the host modal.
- Six-language key parity is tested; real browser interaction used Korean.

final result: passed
