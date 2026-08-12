/**
 * Stand-in aerial imagery for the whole property, plus the traced boundary line.
 * Replaced by a real tiled imagery layer once detection is wired up.
 */
const BOUNDARY_PATH =
  'M262 40 C330 70 420 60 470 110 C540 178 470 240 520 300 C580 372 700 350 760 420 C820 490 760 560 800 640 C840 720 900 740 940 780 L1140 780 C1180 700 1190 560 1160 430 C1130 300 1060 180 960 100 C880 36 700 10 262 40 Z';

export function CourseImagery() {
  return (
    <svg
      viewBox="0 0 1200 800"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <filter id="pgrain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.10 0 0 0 0 0.14 0 0 0 0 0.07 0 0 0 0.4 0"
          />
        </filter>
        <filter id="psoft">
          <feGaussianBlur stdDeviation="12" />
        </filter>
      </defs>

      <rect width="1200" height="800" fill="#2b3f26" />

      {/* Carmel Bay */}
      <path d="M0 0 L250 0 C220 140 300 260 250 400 C210 520 300 640 240 800 L0 800 Z" fill="#1d3c47" />
      <path
        d="M250 0 C220 140 300 260 250 400 C210 520 300 640 240 800"
        fill="none"
        stroke="#8fb3ad"
        strokeWidth="7"
        opacity=".5"
      />
      <path
        d="M250 0 C220 140 300 260 250 400 C210 520 300 640 240 800"
        fill="none"
        stroke="#cfd8c8"
        strokeWidth="18"
        opacity=".22"
      />

      <g filter="url(#psoft)" opacity=".85">
        <ellipse cx="700" cy="120" rx="180" ry="90" fill="#31492a" />
        <ellipse cx="1050" cy="520" rx="200" ry="140" fill="#31492a" />
        <ellipse cx="480" cy="640" rx="180" ry="110" fill="#33502b" />
      </g>

      {/* Fairways */}
      <g fill="#5b8942" opacity=".92">
        <path d="M300 120 C400 100 520 140 610 110 L620 165 C520 195 400 155 305 180 Z" />
        <path d="M330 300 C440 270 560 320 690 280 L700 335 C570 375 440 330 340 360 Z" />
        <path d="M340 470 C470 450 600 500 760 470 L770 525 C610 560 470 505 350 530 Z" />
        <path d="M420 640 C540 620 690 660 860 630 L868 682 C700 715 540 670 428 700 Z" />
        <path d="M820 170 C900 200 980 260 1040 340 L995 375 C935 300 865 245 790 220 Z" />
        <path d="M900 430 C980 460 1050 520 1090 600 L1040 625 C1000 555 940 500 875 475 Z" />
      </g>

      {/* Greens */}
      <g fill="#8bb256">
        <ellipse cx="620" cy="140" rx="26" ry="19" />
        <ellipse cx="700" cy="308" rx="26" ry="19" />
        <ellipse cx="768" cy="498" rx="26" ry="19" />
        <ellipse cx="872" cy="656" rx="26" ry="19" />
        <ellipse cx="1042" cy="352" rx="26" ry="19" />
        <ellipse cx="1084" cy="608" rx="24" ry="18" />
      </g>

      {/* Bunkers */}
      <g fill="#ded1a8" opacity=".95">
        <ellipse cx="576" cy="176" rx="17" ry="10" />
        <ellipse cx="666" cy="342" rx="15" ry="9" />
        <ellipse cx="800" cy="462" rx="18" ry="10" />
        <ellipse cx="1000" cy="392" rx="15" ry="9" />
      </g>

      {/* Tree stands */}
      <g fill="#16260f" filter="url(#psoft)" opacity=".9">
        <ellipse cx="300" cy="240" rx="70" ry="60" />
        <ellipse cx="420" cy="200" rx="55" ry="48" />
        <ellipse cx="380" cy="410" rx="60" ry="52" />
        <ellipse cx="560" cy="560" rx="70" ry="55" />
        <ellipse cx="820" cy="580" rx="60" ry="50" />
        <ellipse cx="960" cy="230" rx="80" ry="62" />
        <ellipse cx="1130" cy="120" rx="90" ry="70" />
        <ellipse cx="700" cy="760" rx="90" ry="60" />
      </g>

      {/* Clubhouse and practice range */}
      <g>
        <rect x="452" y="222" width="70" height="46" rx="4" fill="#cfc7b4" />
        <rect x="470" y="268" width="34" height="22" rx="3" fill="#b6ae9c" />
        <rect x="880" y="700" width="150" height="70" rx="6" fill="#6f9a4d" opacity=".8" />
      </g>

      {/* The traced boundary */}
      <path d={BOUNDARY_PATH} fill="none" stroke="rgba(0,0,0,.45)" strokeWidth="9" />
      <path
        d={BOUNDARY_PATH}
        fill="rgba(62,207,180,.07)"
        stroke="var(--mint-400)"
        strokeWidth="4"
        strokeDasharray="14 10"
      />

      <rect
        width="1200"
        height="800"
        filter="url(#pgrain)"
        opacity=".45"
        style={{ mixBlendMode: 'overlay' }}
      />
    </svg>
  );
}
