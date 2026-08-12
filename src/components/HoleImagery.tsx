/**
 * Stand-in aerial imagery for a single hole, framed tee-to-green.
 * Shares the 1000x680 viewBox with the proposal overlay so clicks land in the same space.
 */
export function HoleImagery() {
  return (
    <svg
      viewBox="0 0 1000 680"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <filter id="hgrain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.10 0 0 0 0 0.14 0 0 0 0 0.07 0 0 0 0.42 0"
          />
        </filter>
        <filter id="hsoft">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      <rect width="1000" height="680" fill="#2b3f26" />

      <g filter="url(#hsoft)" opacity=".8">
        <ellipse cx="300" cy="200" rx="200" ry="120" fill="#334c2b" />
        <ellipse cx="820" cy="480" rx="220" ry="150" fill="#31492a" />
      </g>

      {/* Mown fairway, with two mower stripes */}
      <path
        d="M180 590 C 268 512 348 458 436 390 C 528 318 648 246 776 200 L 818 272 C 696 316 578 384 494 448 C 410 512 336 566 250 636 Z"
        fill="#4f7838"
      />
      <g fill="#59853f" opacity=".55">
        <path d="M196 600 C 284 522 360 470 448 402 C 540 330 656 262 782 216 L 792 234 C 668 280 552 346 468 410 C 384 474 310 528 224 616 Z" />
        <path d="M228 632 C 312 556 388 502 476 434 C 566 364 682 296 806 250 L 814 266 C 692 312 578 376 494 440 C 410 504 338 558 254 646 Z" />
      </g>

      {/* Cart path */}
      <path
        d="M150 640 C 260 560 400 470 560 380 C 680 312 760 250 830 178"
        fill="none"
        stroke="#cbc4b2"
        strokeWidth="5"
        opacity=".4"
      />

      {/* Tee complex */}
      <g fill="#5f8d43">
        <rect x="118" y="602" width="76" height="36" rx="6" />
        <rect x="158" y="568" width="68" height="32" rx="6" />
        <rect x="196" y="538" width="64" height="30" rx="6" />
        <rect x="234" y="510" width="60" height="28" rx="6" />
      </g>

      {/* Green with collar, and its bunkers */}
      <ellipse cx="838" cy="150" rx="66" ry="50" fill="#7ba449" />
      <ellipse cx="838" cy="150" rx="58" ry="43" fill="#8fb955" />
      <ellipse cx="744" cy="214" rx="34" ry="20" fill="#ded1a8" />
      <ellipse cx="906" cy="208" rx="27" ry="17" fill="#ded1a8" />

      {/* The decoy green that trips the yardage check */}
      <ellipse cx="524" cy="330" rx="30" ry="20" fill="#7ba449" opacity=".8" />

      <g fill="#16260f" filter="url(#hsoft)" opacity=".92">
        <ellipse cx="80" cy="120" rx="120" ry="90" />
        <ellipse cx="300" cy="60" rx="90" ry="60" />
        <ellipse cx="70" cy="420" rx="90" ry="80" />
        <ellipse cx="560" cy="600" rx="130" ry="80" />
        <ellipse cx="960" cy="560" rx="110" ry="90" />
        <ellipse cx="620" cy="90" rx="80" ry="55" />
      </g>
      <g fill="#1e3315" opacity=".7">
        <ellipse cx="420" cy="150" rx="46" ry="34" />
        <ellipse cx="960" cy="300" rx="50" ry="40" />
      </g>

      <line
        x1="150"
        y1="620"
        x2="838"
        y2="150"
        stroke="#fff"
        strokeWidth="1.5"
        strokeDasharray="3 8"
        opacity=".3"
      />

      <rect
        width="1000"
        height="680"
        filter="url(#hgrain)"
        opacity=".45"
        style={{ mixBlendMode: 'overlay' }}
      />
    </svg>
  );
}
