# Motion Background and Frosted Login Design

## Scope

Replace the current static page background with the authorized MotionSites asset “Motion Background 14” and restyle the login card as dark frosted glass. No generator workflow, project data, authentication behavior, or account state changes are included.

## Background media

The page will render the provided MotionSites MP4 as a decorative background video. It will be muted, autoplayed, looped, and marked `playsinline`, with no controls and no keyboard or accessibility focus. The video will remain behind all interface content and use `object-fit: cover`.

Desktop and mobile layouts will set separate `object-position` values so the most useful motion remains visible after cropping. The existing alpine runner image will remain as the CSS background and video poster fallback because the supplied relative thumbnail file is not present in the project checkout. This fallback also covers slow networks, playback rejection, and reduced-motion preferences.

The existing dark overlay will be reduced and tuned for legibility rather than used as an opaque visual layer. Foreground panels will retain their own contrast, so the moving image remains visible outside text and control areas.

Users who request reduced motion will see the static poster instead of the looping background.

## Login glass treatment

The login card will become a dark frosted-glass surface using a translucent charcoal fill, backdrop blur, mild saturation, a subtle light border, a soft top-edge highlight, and a restrained shadow. Inputs will use a matching inset translucent surface with clear focus states. The treatment will preserve the existing layout, labels, login behavior, and responsive sizing.

Mobile styling will use a slightly lower blur strength to reduce rendering cost while preserving the same visual character and contrast.

## Failure and fallback behavior

If the remote video cannot load or autoplay, the existing alpine runner poster remains visible without exposing a broken media control. The background video has no application state and cannot block login or workspace interaction.

The MotionSites URL is used only after the user confirmed commercial-use authorization. The asset remains referenced from its supplied cloud URL rather than copied into the site bundle.

## Verification

Automated tests will verify the decorative video attributes, remote source, poster, hidden controls, accessibility treatment, reduced-motion fallback, responsive focal positioning, and dark frosted-glass rules. The full existing test suite and production build must pass before publishing. After deployment, the live Site status and recent worker errors will be checked.
