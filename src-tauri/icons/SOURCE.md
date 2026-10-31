# App icon

`source.svg` is the OB tile from `openbot-ui/public/favicon.svg`, at UI commit
`5362712082f3482173f9e3aee7be8bf75834a8e1`.

The image files were made with the pinned Tauri CLI:

```sh
devenv shell -- rsvg-convert --width 1024 --height 1024 --output .cache/openbot-icon.png src-tauri/icons/source.svg
devenv shell -- pnpm tauri icon .cache/openbot-icon.png --output src-tauri/icons
```

The SVG contains text. The CLI's SVG reader drops it, so render it with librsvg
first. Check that both letters are visible in the output before building.
Run the same commands after changing the source. Recheck generated Android and
iOS assets when their projects are present.
