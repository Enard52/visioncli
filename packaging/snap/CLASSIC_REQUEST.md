# Classic confinement request (forum.snapcraft.io → store-requests)

Title: `Classic confinement request: visioncli`

```
Hi! I'd like to request classic confinement for the snap "visioncli".

What it is:
VisionCLI is an open-source (MIT) AI co-assistant for developers. You hold a key and ask, by voice or text, about the file, error or window on screen; it answers through the AI coding CLI the developer already uses (Claude Code or Gemini/Antigravity) and can carry out tasks by clicking and typing in other apps, with every action approved by the user.

Why strict confinement can't work:
- It runs the user's own developer CLIs from the host (claude, agy, gemini), with their existing installs and sign-ins, plus tmux to type into a running CLI session.
- It drives other desktop applications: window listing and capture (xdotool, wmctrl, maim, grim), and finding/pressing buttons through AT-SPI.
- Hold-to-talk reads key presses from /dev/input (the user joins the input group).
- It captures the whole screen and the window under the mouse, across all apps.
There are no strict interfaces for running arbitrary host programs, so it falls in the "IDEs, terminals and developer tools" category.

Source: https://github.com/thethirdsourcers/visioncli
snapcraft.yaml: https://github.com/thethirdsourcers/visioncli/blob/main/packaging/snap/snapcraft.yaml
Website: https://visioncli.thethirdsourcers.com
Publisher: Third Sourcers (https://thethirdsourcers.com)

Thanks!
```
