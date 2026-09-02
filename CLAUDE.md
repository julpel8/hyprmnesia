# Claude Notes

- `hpm quit` and the tray menu item `Quit Hyprmnesia` are full shutdown paths:
  stop the daemon first, then quit the tray.
- Do not create duplicate tray icons. Any user-facing command that needs the
  tray must check for an existing live tray before launching one.
- Headless, test, and internal control paths should stop the daemon directly and
  must not launch the tray as a side effect.
- No pull requests: work lands by pushing to `main`. CI runs on `main`, and a
  green CI run triggers the Release workflow, which bumps the patch version,
  tags `vX.Y.Z`, and publishes a GitHub release.
- Release notes come from the commit subjects since the previous tag, so write
  commit messages that read well in a changelog.
