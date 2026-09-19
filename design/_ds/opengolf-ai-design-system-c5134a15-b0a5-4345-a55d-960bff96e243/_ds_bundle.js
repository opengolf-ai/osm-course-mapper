/* @ds-bundle: {"format":4,"namespace":"OpengolfAiDesignSystem_c5134a","components":[{"name":"Logo","sourcePath":"components/brand/Logo.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"CodeBlock","sourcePath":"components/data/CodeBlock.jsx"},{"name":"DataTable","sourcePath":"components/data/DataTable.jsx"},{"name":"StatTile","sourcePath":"components/data/StatTile.jsx"},{"name":"Callout","sourcePath":"components/feedback/Callout.jsx"},{"name":"Dialog","sourcePath":"components/feedback/Dialog.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Breadcrumbs","sourcePath":"components/navigation/Breadcrumbs.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"}],"sourceHashes":{"components/brand/Logo.jsx":"c05a6d3286c6","components/core/Badge.jsx":"8cd241248b1c","components/core/Button.jsx":"fede28eb3b02","components/core/Card.jsx":"e4bef39b0eba","components/core/Icon.jsx":"37b31dafcc62","components/core/IconButton.jsx":"6b9d212dee40","components/core/Tag.jsx":"8b8e08b78dcd","components/data/CodeBlock.jsx":"dd92690ecb97","components/data/DataTable.jsx":"a58815a628d2","components/data/StatTile.jsx":"757dc02583a8","components/feedback/Callout.jsx":"dbc8015f5b01","components/feedback/Dialog.jsx":"82902df2584f","components/feedback/Toast.jsx":"01f3e8a6652e","components/feedback/Tooltip.jsx":"60b0272d1d3c","components/forms/Checkbox.jsx":"1c2d5eb66c33","components/forms/Input.jsx":"39e383ceca72","components/forms/Select.jsx":"d2e1817e22e9","components/forms/Switch.jsx":"67e56b2a93c5","components/navigation/Breadcrumbs.jsx":"4623370fbc3a","components/navigation/Tabs.jsx":"7492291e16c5","ui_kits/explorer/AppShell.jsx":"6fd14ad7a947","ui_kits/explorer/BenchmarkScreen.jsx":"88c4370a8fec","ui_kits/explorer/DatasetDetail.jsx":"3ee9f4591974","ui_kits/explorer/DatasetsScreen.jsx":"befb0120e954","ui_kits/website/CommunitySection.jsx":"4097383ddd7c","ui_kits/website/DataSection.jsx":"fca9204c35f3","ui_kits/website/Hero.jsx":"d26f06363067","ui_kits/website/ProjectsGrid.jsx":"5be7526ddcc7","ui_kits/website/SiteFooter.jsx":"433be5ab8888","ui_kits/website/SiteHeader.jsx":"7c6d7a19359c"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.OpengolfAiDesignSystem_c5134a = window.OpengolfAiDesignSystem_c5134a || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/brand/Logo.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* The wordmark and flag mark are raster assets extracted from the supplied brand art.
   Never redraw them; scale the PNGs. */
function Logo({
  variant = 'lockup-h',
  height,
  basePath,
  style,
  ...rest
}) {
  const base = basePath || typeof window !== 'undefined' && window.OG_ASSET_BASE || 'assets';
  const h = height || (variant === 'mark' ? 34 : 28);
  const mark = /*#__PURE__*/React.createElement("img", {
    src: base + '/logo-mark.png',
    alt: "",
    style: {
      height: variant === 'lockup-h' ? h * 1.5 : h,
      width: 'auto',
      display: 'block'
    }
  });
  const word = /*#__PURE__*/React.createElement("img", {
    src: base + '/logo-wordmark.png',
    alt: "opengolf.ai",
    style: {
      height: h,
      width: 'auto',
      display: 'block'
    }
  });
  if (variant === 'mark') return /*#__PURE__*/React.createElement("span", _extends({}, rest, {
    style: {
      display: 'inline-flex',
      ...style
    }
  }), mark);
  if (variant === 'wordmark') return /*#__PURE__*/React.createElement("span", _extends({}, rest, {
    style: {
      display: 'inline-flex',
      ...style
    }
  }), word);
  if (variant === 'lockup-v') {
    return /*#__PURE__*/React.createElement("span", _extends({}, rest, {
      style: {
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
        ...style
      }
    }), /*#__PURE__*/React.createElement("img", {
      src: base + '/logo-mark.png',
      alt: "",
      style: {
        height: h * 2.6,
        width: 'auto'
      }
    }), word);
  }
  return /*#__PURE__*/React.createElement("span", _extends({}, rest, {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: h * 0.42,
      ...style
    }
  }), mark, word);
}
Object.assign(__ds_scope, { Logo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/Logo.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Card({
  children,
  padding = 'md',
  tone = 'default',
  interactive = false,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const pad = {
    none: 0,
    sm: 'var(--space-4)',
    md: 'var(--space-6)',
    lg: 'var(--space-8)'
  }[padding] ?? padding;
  const tones = {
    default: {
      background: 'var(--surface-card)',
      border: '1px solid var(--border-subtle)'
    },
    sunken: {
      background: 'var(--surface-sunken)',
      border: '1px solid var(--border-subtle)'
    },
    accent: {
      background: 'var(--surface-accent-soft)',
      border: '1px solid var(--border-accent)'
    },
    inverse: {
      background: 'var(--surface-inverse)',
      border: '1px solid rgba(255,255,255,.12)',
      color: 'var(--green-100)'
    }
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, rest, {
    style: {
      borderRadius: 'var(--radius-lg)',
      padding: pad,
      boxShadow: interactive && hover ? 'var(--shadow-md)' : 'var(--shadow-xs)',
      transform: interactive && hover ? 'translateY(-2px)' : 'none',
      transition: 'box-shadow var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out), border-color var(--duration-base) var(--ease-out)',
      cursor: interactive ? 'pointer' : 'default',
      ...tones[tone],
      ...style
    }
  }), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Icons are Lucide 24x24 stroke-1.5 SVGs copied into assets/icons.
   The SVG markup is fetched once per URL and inlined so stroke/fill inherit currentColor. */
const CACHE = {};
function load(url) {
  if (!CACHE[url]) {
    CACHE[url] = {
      p: fetch(url).then(r => r.ok ? r.text() : '').then(t => t.replace(/<\?xml[^>]*\?>/g, '').replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '').replace(/<svg/, '<svg width="100%" height="100%"')).catch(() => ''),
      v: ''
    };
  }
  return CACHE[url];
}
function Icon({
  name,
  size = 18,
  basePath,
  style,
  title,
  ...rest
}) {
  const base = basePath || typeof window !== 'undefined' && window.OG_ICON_BASE || 'assets/icons';
  const url = base + '/' + name + '.svg';
  const [markup, setMarkup] = React.useState(CACHE[url] && CACHE[url].v || '');
  React.useEffect(() => {
    let live = true;
    const entry = load(url);
    if (entry.v) {
      setMarkup(entry.v);
      return;
    }
    entry.p.then(t => {
      entry.v = t;
      if (live) setMarkup(t);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return /*#__PURE__*/React.createElement("span", _extends({
    role: title ? 'img' : 'presentation',
    "aria-label": title
  }, rest, {
    dangerouslySetInnerHTML: {
      __html: markup
    },
    style: {
      display: 'inline-block',
      width: size,
      height: size,
      flex: '0 0 auto',
      color: 'inherit',
      lineHeight: 0,
      ...style
    }
  }));
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONES = {
  neutral: ['var(--paper-2)', 'var(--ink-600)', 'var(--border-default)'],
  brand: ['var(--green-50)', 'var(--green-700)', 'var(--green-200)'],
  accent: ['var(--mint-100)', 'var(--mint-600)', 'var(--mint-200)'],
  success: ['var(--status-success-bg)', 'var(--status-success-fg)', 'var(--green-200)'],
  warning: ['var(--status-warning-bg)', 'var(--status-warning-fg)', '#eed9ac'],
  danger: ['var(--status-danger-bg)', 'var(--status-danger-fg)', '#eec6bb'],
  info: ['var(--status-info-bg)', 'var(--status-info-fg)', '#bcd9e8']
};
function Badge({
  children,
  tone = 'neutral',
  icon,
  dot = false,
  style,
  ...rest
}) {
  const [bg, fg, bd] = TONES[tone] || TONES.neutral;
  return /*#__PURE__*/React.createElement("span", _extends({}, rest, {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 22,
      padding: '0 9px',
      borderRadius: 'var(--radius-pill)',
      background: bg,
      color: fg,
      border: '1px solid ' + bd,
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-micro)',
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      ...style
    }
  }), dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: fg
    }
  }), icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 12
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: {
    h: 30,
    px: 12,
    fs: 13,
    gap: 6,
    icon: 14,
    r: 'var(--radius-sm)'
  },
  md: {
    h: 38,
    px: 16,
    fs: 15,
    gap: 8,
    icon: 16,
    r: 'var(--radius-md)'
  },
  lg: {
    h: 46,
    px: 22,
    fs: 16,
    gap: 9,
    icon: 18,
    r: 'var(--radius-md)'
  }
};
function palette(variant, hover, active) {
  switch (variant) {
    case 'secondary':
      return {
        background: hover ? 'var(--paper-2)' : 'var(--white)',
        color: 'var(--text-heading)',
        border: '1px solid ' + (hover ? 'var(--border-strong)' : 'var(--border-default)'),
        boxShadow: active ? 'none' : 'var(--shadow-xs)'
      };
    case 'ghost':
      return {
        background: hover ? 'var(--green-50)' : 'transparent',
        color: 'var(--text-accent)',
        border: '1px solid transparent',
        boxShadow: 'none'
      };
    case 'accent':
      return {
        background: active ? 'var(--mint-600)' : hover ? 'var(--mint-500)' : 'var(--mint-400)',
        color: 'var(--green-950)',
        border: '1px solid transparent',
        boxShadow: 'none'
      };
    case 'danger':
      return {
        background: hover ? '#9d3b28' : 'var(--clay-500)',
        color: 'var(--white)',
        border: '1px solid transparent',
        boxShadow: 'none'
      };
    default:
      return {
        background: active ? 'var(--brand-primary-active)' : hover ? 'var(--brand-primary-hover)' : 'var(--brand-primary)',
        color: 'var(--text-inverse)',
        border: '1px solid transparent',
        boxShadow: active ? 'none' : 'var(--shadow-xs)'
      };
  }
}
function Button({
  children,
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  disabled = false,
  fullWidth = false,
  as = 'button',
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const Tag = as;
  return /*#__PURE__*/React.createElement(Tag, _extends({
    disabled: Tag === 'button' ? disabled : undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setActive(false);
    },
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false)
  }, rest, {
    style: {
      display: fullWidth ? 'flex' : 'inline-flex',
      width: fullWidth ? '100%' : undefined,
      alignItems: 'center',
      justifyContent: 'center',
      gap: s.gap,
      height: s.h,
      padding: `0 ${s.px}px`,
      borderRadius: s.r,
      fontFamily: 'var(--font-sans)',
      fontSize: s.fs,
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: '-0.005em',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      cursor: disabled ? 'not-allowed' : 'pointer',
      textDecoration: 'none',
      opacity: disabled ? 0.45 : 1,
      transform: active && !disabled ? 'translateY(1px)' : 'none',
      transition: 'var(--transition-control)',
      ...palette(variant, hover && !disabled, active && !disabled),
      ...style
    }
  }), iconLeft && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: iconLeft,
    size: s.icon
  }), children, iconRight && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: iconRight,
    size: s.icon
  }));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: {
    box: 30,
    icon: 15
  },
  md: {
    box: 38,
    icon: 18
  },
  lg: {
    box: 46,
    icon: 20
  }
};
function IconButton({
  icon,
  label,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const skin = variant === 'primary' ? {
    background: hover ? 'var(--brand-primary-hover)' : 'var(--brand-primary)',
    color: 'var(--text-inverse)',
    border: '1px solid transparent'
  } : variant === 'ghost' ? {
    background: hover ? 'var(--paper-2)' : 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid transparent'
  } : {
    background: hover ? 'var(--paper-2)' : 'var(--white)',
    color: 'var(--text-heading)',
    border: '1px solid ' + (hover ? 'var(--border-strong)' : 'var(--border-default)')
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    "aria-label": label,
    title: label,
    disabled: disabled,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, rest, {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: s.box,
      height: s.box,
      borderRadius: 'var(--radius-md)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      transition: 'var(--transition-control)',
      ...skin,
      ...style
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: s.icon
  }));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Tag({
  children,
  selected = false,
  onRemove,
  onClick,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const clickable = !!onClick;
  return /*#__PURE__*/React.createElement("span", _extends({
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, rest, {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 26,
      padding: '0 10px',
      borderRadius: 'var(--radius-sm)',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-caption)',
      background: selected ? 'var(--green-800)' : hover && clickable ? 'var(--paper-2)' : 'var(--white)',
      color: selected ? 'var(--paper)' : 'var(--ink-600)',
      border: '1px solid ' + (selected ? 'var(--green-800)' : 'var(--border-default)'),
      cursor: clickable ? 'pointer' : 'default',
      transition: 'var(--transition-control)',
      ...style
    }
  }), children, onRemove && /*#__PURE__*/React.createElement("span", {
    onClick: e => {
      e.stopPropagation();
      onRemove(e);
    },
    style: {
      display: 'inline-flex',
      cursor: 'pointer',
      opacity: 0.6
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 12
  })));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/data/CodeBlock.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function CodeBlock({
  code = '',
  language = 'bash',
  filename,
  copyable = true,
  style,
  ...rest
}) {
  const [copied, setCopied] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", _extends({}, rest, {
    style: {
      background: 'var(--green-950)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,.08)',
      ...style
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 12px',
      borderBottom: '1px solid rgba(255,255,255,.08)',
      background: 'rgba(255,255,255,.03)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-micro)',
      color: 'var(--green-300)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: language === 'bash' ? 'terminal' : 'code',
    size: 13
  }), filename || language), copyable && /*#__PURE__*/React.createElement("span", {
    onClick: () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      cursor: 'pointer',
      fontSize: 'var(--text-micro)',
      color: copied ? 'var(--mint-400)' : 'var(--green-300)',
      fontFamily: 'var(--font-mono)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: copied ? 'check' : 'copy',
    size: 13
  }), copied ? 'copied' : 'copy')), /*#__PURE__*/React.createElement("pre", {
    style: {
      margin: 0,
      padding: '14px 16px',
      overflowX: 'auto',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-body-sm)',
      lineHeight: 1.65,
      color: 'var(--green-100)'
    }
  }, code));
}
Object.assign(__ds_scope, { CodeBlock });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/CodeBlock.jsx", error: String((e && e.message) || e) }); }

// components/data/DataTable.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function DataTable({
  columns = [],
  rows = [],
  dense = false,
  style,
  ...rest
}) {
  const [hoverRow, setHoverRow] = React.useState(-1);
  const pad = dense ? '7px 12px' : '11px 14px';
  return /*#__PURE__*/React.createElement("div", _extends({}, rest, {
    style: {
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      background: 'var(--surface-card)',
      ...style
    }
  }), /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-body-sm)'
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: 'var(--surface-sunken)'
    }
  }, columns.map(c => /*#__PURE__*/React.createElement("th", {
    key: c.key,
    style: {
      textAlign: c.align || 'left',
      padding: pad,
      whiteSpace: 'nowrap',
      fontSize: 'var(--text-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-muted)',
      borderBottom: '1px solid var(--border-subtle)',
      width: c.width
    }
  }, c.label)))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    onMouseEnter: () => setHoverRow(i),
    onMouseLeave: () => setHoverRow(-1),
    style: {
      background: hoverRow === i ? 'var(--green-50)' : 'transparent',
      transition: 'background-color var(--duration-fast) var(--ease-out)'
    }
  }, columns.map(c => /*#__PURE__*/React.createElement("td", {
    key: c.key,
    style: {
      padding: pad,
      textAlign: c.align || 'left',
      borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border-subtle)',
      fontFamily: c.mono ? 'var(--font-mono)' : 'var(--font-sans)',
      color: c.muted ? 'var(--text-muted)' : 'var(--text-body)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap'
    }
  }, r[c.key])))))));
}
Object.assign(__ds_scope, { DataTable });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/DataTable.jsx", error: String((e && e.message) || e) }); }

// components/data/StatTile.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function StatTile({
  label,
  value,
  unit,
  delta,
  deltaTone = 'positive',
  icon,
  style,
  ...rest
}) {
  const dcol = deltaTone === 'positive' ? 'var(--green-500)' : deltaTone === 'negative' ? 'var(--clay-500)' : 'var(--text-muted)';
  return /*#__PURE__*/React.createElement("div", _extends({}, rest, {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: 'var(--space-4)',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-xs)',
      ...style
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 'var(--text-micro)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      fontWeight: 'var(--weight-semibold)'
    }
  }, icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 13
  }), label), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 26,
      fontWeight: 'var(--weight-medium)',
      color: 'var(--text-heading)',
      letterSpacing: '-0.02em'
    }
  }, value), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-faint)'
    }
  }, unit)), delta && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 'var(--text-caption)',
      color: dcol,
      fontFamily: 'var(--font-mono)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "trending-up",
    size: 13
  }), delta));
}
Object.assign(__ds_scope, { StatTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/StatTile.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Callout.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONES = {
  note: {
    bg: 'var(--surface-sunken)',
    bd: 'var(--border-default)',
    fg: 'var(--ink-600)',
    icon: 'info'
  },
  brand: {
    bg: 'var(--green-50)',
    bd: 'var(--green-200)',
    fg: 'var(--green-700)',
    icon: 'flag'
  },
  success: {
    bg: 'var(--status-success-bg)',
    bd: 'var(--green-200)',
    fg: 'var(--status-success-fg)',
    icon: 'circle-check'
  },
  warning: {
    bg: 'var(--status-warning-bg)',
    bd: '#eed9ac',
    fg: 'var(--status-warning-fg)',
    icon: 'circle-alert'
  },
  danger: {
    bg: 'var(--status-danger-bg)',
    bd: '#eec6bb',
    fg: 'var(--status-danger-fg)',
    icon: 'circle-alert'
  }
};
function Callout({
  title,
  children,
  tone = 'note',
  icon,
  style,
  ...rest
}) {
  const t = TONES[tone] || TONES.note;
  return /*#__PURE__*/React.createElement("div", _extends({}, rest, {
    style: {
      display: 'flex',
      gap: 10,
      padding: 'var(--space-4)',
      background: t.bg,
      border: '1px solid ' + t.bd,
      borderRadius: 'var(--radius-md)',
      ...style
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: t.fg,
      display: 'inline-flex',
      marginTop: 1
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon || t.icon,
    size: 17
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      minWidth: 0
    }
  }, title && /*#__PURE__*/React.createElement("strong", {
    style: {
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-heading)',
      fontWeight: 'var(--weight-semibold)'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-body)',
      lineHeight: 'var(--leading-normal)'
    }
  }, children)));
}
Object.assign(__ds_scope, { Callout });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Callout.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Dialog.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Dialog({
  open = true,
  title,
  description,
  children,
  onClose,
  primaryAction,
  secondaryAction,
  width = 460,
  style,
  ...rest
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--overlay-scrim)',
      backdropFilter: 'blur(2px)',
      padding: 24,
      zIndex: 40
    },
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", _extends({
    role: "dialog",
    onClick: e => e.stopPropagation()
  }, rest, {
    style: {
      width,
      maxWidth: '100%',
      background: 'var(--surface-card)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-lg)',
      border: '1px solid var(--border-subtle)',
      overflow: 'hidden',
      ...style
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '20px 20px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: 'var(--text-h4)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-heading)'
    }
  }, title), description && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-muted)'
    }
  }, description)), onClose && /*#__PURE__*/React.createElement("span", {
    onClick: onClose,
    style: {
      cursor: 'pointer',
      color: 'var(--text-faint)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 17
  }))), children && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 20px 0',
      fontSize: 'var(--text-body)'
    }
  }, children), (primaryAction || secondaryAction) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      padding: 20,
      marginTop: 16,
      borderTop: '1px solid var(--border-subtle)',
      background: 'var(--surface-sunken)'
    }
  }, secondaryAction && /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "secondary",
    size: "sm",
    onClick: secondaryAction.onClick
  }, secondaryAction.label), primaryAction && /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    onClick: primaryAction.onClick
  }, primaryAction.label))));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const ICONS = {
  success: 'circle-check',
  error: 'circle-alert',
  info: 'info'
};
function Toast({
  title,
  description,
  tone = 'info',
  onClose,
  action,
  style,
  ...rest
}) {
  const fg = tone === 'success' ? 'var(--mint-400)' : tone === 'error' ? '#e08e79' : 'var(--green-200)';
  return /*#__PURE__*/React.createElement("div", _extends({}, rest, {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      minWidth: 300,
      maxWidth: 420,
      padding: '12px 14px',
      borderRadius: 'var(--radius-md)',
      background: 'var(--green-900)',
      color: 'var(--green-100)',
      boxShadow: 'var(--shadow-lg)',
      border: '1px solid rgba(255,255,255,.10)',
      ...style
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: fg,
      display: 'inline-flex',
      marginTop: 1
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: ICONS[tone] || 'info',
    size: 17
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      fontSize: 'var(--text-body-sm)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--white)'
    }
  }, title), description && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-caption)',
      color: 'var(--green-200)'
    }
  }, description), action && /*#__PURE__*/React.createElement("span", {
    style: {
      marginTop: 6,
      fontSize: 'var(--text-caption)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--mint-400)',
      cursor: 'pointer'
    },
    onClick: action.onClick
  }, action.label)), onClose && /*#__PURE__*/React.createElement("span", {
    onClick: onClose,
    style: {
      cursor: 'pointer',
      color: 'var(--green-300)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 15
  })));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Tooltip({
  label,
  children,
  placement = 'top',
  style,
  ...rest
}) {
  const [open, setOpen] = React.useState(false);
  const pos = {
    top: {
      bottom: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      marginBottom: 7
    },
    bottom: {
      top: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      marginTop: 7
    },
    left: {
      right: '100%',
      top: '50%',
      transform: 'translateY(-50%)',
      marginRight: 7
    },
    right: {
      left: '100%',
      top: '50%',
      transform: 'translateY(-50%)',
      marginLeft: 7
    }
  }[placement];
  return /*#__PURE__*/React.createElement("span", _extends({}, rest, {
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    style: {
      position: 'relative',
      display: 'inline-flex',
      ...style
    }
  }), children, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      ...pos,
      zIndex: 30,
      pointerEvents: 'none',
      padding: '5px 9px',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--green-950)',
      color: 'var(--green-100)',
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-micro)',
      whiteSpace: 'nowrap',
      boxShadow: 'var(--shadow-md)',
      opacity: open ? 1 : 0,
      transition: 'opacity var(--duration-fast) var(--ease-out)'
    }
  }, label));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Checkbox({
  label,
  description,
  checked = false,
  disabled = false,
  onChange,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", _extends({}, rest, {
    style: {
      display: 'flex',
      alignItems: description ? 'flex-start' : 'center',
      gap: 10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }), /*#__PURE__*/React.createElement("span", {
    onClick: () => !disabled && onChange && onChange(!checked),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      flex: '0 0 auto',
      marginTop: description ? 2 : 0,
      borderRadius: 'var(--radius-xs)',
      background: checked ? 'var(--brand-primary)' : 'var(--white)',
      border: '1px solid ' + (checked ? 'var(--brand-primary)' : 'var(--border-strong)'),
      color: 'var(--white)',
      transition: 'var(--transition-control)'
    }
  }, checked && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "check",
    size: 13
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-body)',
      color: 'var(--text-body)'
    }
  }, label), description && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-caption)',
      color: 'var(--text-muted)'
    }
  }, description)));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Input({
  label,
  hint,
  error,
  icon,
  size = 'md',
  mono = false,
  style,
  id,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const h = size === 'sm' ? 32 : size === 'lg' ? 46 : 38;
  const fid = id || (label ? 'in-' + label.replace(/\W+/g, '-').toLowerCase() : undefined);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      width: '100%'
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: fid,
    style: {
      fontSize: 'var(--text-body-sm)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-heading)'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: h,
      padding: '0 12px',
      background: 'var(--white)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid ' + (error ? 'var(--clay-500)' : focus ? 'var(--border-focus)' : 'var(--border-default)'),
      boxShadow: focus ? 'var(--shadow-focus)' : 'none',
      transition: 'var(--transition-control)'
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-faint)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 16
  })), /*#__PURE__*/React.createElement("input", _extends({
    id: fid,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false)
  }, rest, {
    style: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      minWidth: 0,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
      fontSize: size === 'sm' ? 13 : 15,
      color: 'var(--text-body)',
      ...style
    }
  }))), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-caption)',
      color: error ? 'var(--clay-500)' : 'var(--text-muted)'
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Select({
  label,
  hint,
  options = [],
  size = 'md',
  style,
  id,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const h = size === 'sm' ? 32 : size === 'lg' ? 46 : 38;
  const fid = id || (label ? 'sel-' + label.replace(/\W+/g, '-').toLowerCase() : undefined);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      width: '100%'
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: fid,
    style: {
      fontSize: 'var(--text-body-sm)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-heading)'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      height: h,
      background: 'var(--white)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid ' + (focus ? 'var(--border-focus)' : 'var(--border-default)'),
      boxShadow: focus ? 'var(--shadow-focus)' : 'none',
      transition: 'var(--transition-control)'
    }
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: fid,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false)
  }, rest, {
    style: {
      appearance: 'none',
      WebkitAppearance: 'none',
      width: '100%',
      height: '100%',
      padding: '0 34px 0 12px',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: 'var(--font-sans)',
      fontSize: size === 'sm' ? 13 : 15,
      color: 'var(--text-body)',
      cursor: 'pointer',
      ...style
    }
  }), options.map(o => {
    const v = typeof o === 'string' ? o : o.value;
    const l = typeof o === 'string' ? o : o.label;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: 11,
      color: 'var(--text-faint)',
      pointerEvents: 'none',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-down",
    size: 16
  }))), hint && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-caption)',
      color: 'var(--text-muted)'
    }
  }, hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Switch({
  label,
  checked = false,
  disabled = false,
  onChange,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", _extends({}, rest, {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }), /*#__PURE__*/React.createElement("span", {
    onClick: () => !disabled && onChange && onChange(!checked),
    style: {
      position: 'relative',
      width: 38,
      height: 22,
      borderRadius: 999,
      flex: '0 0 auto',
      background: checked ? 'var(--mint-500)' : 'var(--ink-200)',
      transition: 'background-color var(--duration-base) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 3,
      left: checked ? 19 : 3,
      width: 16,
      height: 16,
      borderRadius: 999,
      background: 'var(--white)',
      boxShadow: 'var(--shadow-sm)',
      transition: 'left var(--duration-base) var(--ease-standard)'
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-body)',
      color: 'var(--text-body)'
    }
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Breadcrumbs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Breadcrumbs({
  items = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({}, rest, {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
      ...style
    }
  }), items.map((it, i) => {
    const label = typeof it === 'string' ? it : it.label;
    const href = typeof it === 'string' ? undefined : it.href;
    const last = i === items.length - 1;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: label + i
    }, i > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--text-faint)',
        display: 'inline-flex'
      }
    }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: "chevron-right",
      size: 14
    })), /*#__PURE__*/React.createElement("a", {
      href: last ? undefined : href || '#',
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-caption)',
        color: last ? 'var(--text-heading)' : 'var(--text-muted)',
        fontWeight: last ? 'var(--weight-medium)' : 'var(--weight-regular)',
        textDecoration: 'none',
        cursor: last ? 'default' : 'pointer'
      }
    }, label));
  }));
}
Object.assign(__ds_scope, { Breadcrumbs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Breadcrumbs.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Tabs({
  tabs = [],
  value,
  onChange,
  variant = 'underline',
  style,
  ...rest
}) {
  const active = value ?? (tabs[0] && (tabs[0].value || tabs[0]));
  const norm = tabs.map(t => typeof t === 'string' ? {
    value: t,
    label: t
  } : t);
  const isPill = variant === 'pill';
  return /*#__PURE__*/React.createElement("div", _extends({}, rest, {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: isPill ? 4 : 24,
      borderBottom: isPill ? 'none' : '1px solid var(--border-subtle)',
      background: isPill ? 'var(--surface-sunken)' : 'transparent',
      padding: isPill ? 4 : 0,
      borderRadius: isPill ? 'var(--radius-md)' : 0,
      ...style
    }
  }), norm.map(t => {
    const on = t.value === active;
    return /*#__PURE__*/React.createElement("button", {
      key: t.value,
      onClick: () => onChange && onChange(t.value),
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        cursor: 'pointer',
        border: 'none',
        background: isPill ? on ? 'var(--white)' : 'transparent' : 'transparent',
        boxShadow: isPill && on ? 'var(--shadow-xs)' : 'none',
        borderRadius: isPill ? 'var(--radius-sm)' : 0,
        padding: isPill ? '6px 12px' : '0 0 11px',
        marginBottom: isPill ? 0 : -1,
        borderBottom: isPill ? 'none' : '2px solid ' + (on ? 'var(--brand-primary)' : 'transparent'),
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-body-sm)',
        fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
        color: on ? 'var(--text-heading)' : 'var(--text-muted)',
        transition: 'var(--transition-control)'
      }
    }, t.icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: t.icon,
      size: 15
    }), t.label, t.count != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-faint)'
      }
    }, t.count));
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/explorer/AppShell.jsx
try { (() => {
const {
  Logo,
  Icon,
  Input,
  IconButton,
  Badge,
  Button
} = window.OG;
const NAV = [['datasets', 'Datasets', 'database'], ['courses', 'Courses', 'map-pin'], ['bench', 'Benchmark', 'trending-up'], ['api', 'API keys', 'code'], ['docs', 'Docs', 'book-open']];
function AppShell({
  view,
  onView,
  onNewKey,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: '100vh',
      background: 'var(--surface-sunken)',
      overflow: 'hidden',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 236,
      flex: '0 0 236px',
      background: 'var(--surface-card)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      padding: '18px 12px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 8px 18px'
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    height: 19
  })), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, NAV.map(([k, l, ic]) => {
    const on = view === k;
    return /*#__PURE__*/React.createElement("button", {
      key: k,
      onClick: () => onView(k),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 34,
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        background: on ? 'var(--green-50)' : 'transparent',
        color: on ? 'var(--green-800)' : 'var(--ink-600)',
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        fontWeight: on ? 600 : 500,
        textAlign: 'left',
        transition: 'var(--transition-control)'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: ic,
      size: 16
    }), l);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: 8,
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-sunken)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-label)',
      fontWeight: 600,
      color: 'var(--text-muted)'
    }
  }, "Free tier"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--ink-600)',
      lineHeight: 1.5
    }
  }, "1,000 requests/hour. No card, no account."), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "secondary",
    fullWidth: true,
    onClick: onNewKey
  }, "Create a key"))), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 58,
      flex: '0 0 58px',
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '0 22px',
      background: 'var(--surface-card)',
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 320
    }
  }, /*#__PURE__*/React.createElement(Input, {
    size: "sm",
    icon: "search",
    placeholder: "Search datasets, courses, players",
    mono: true
  })), /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true,
    style: {
      marginLeft: 'auto'
    }
  }, "registry synced"), /*#__PURE__*/React.createElement(IconButton, {
    icon: "list-filter",
    label: "Filters",
    variant: "ghost",
    size: "sm"
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: "settings",
    label: "Settings",
    variant: "ghost",
    size: "sm"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 999,
      background: 'var(--green-800)',
      color: 'var(--paper)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 12,
      fontWeight: 700
    }
  }, "AK")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto',
      padding: 22
    }
  }, children)));
}
Object.assign(window, {
  AppShell
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/explorer/AppShell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/explorer/BenchmarkScreen.jsx
try { (() => {
const {
  DataTable,
  Badge,
  Card,
  Tabs,
  Callout,
  StatTile
} = window.OG;
const COLS = [{
  key: 'rank',
  label: '#',
  align: 'right',
  mono: true,
  muted: true
}, {
  key: 'model',
  label: 'Model',
  mono: true
}, {
  key: 'team',
  label: 'Submitted by'
}, {
  key: 'sg',
  label: 'SG/round',
  align: 'right',
  mono: true
}, {
  key: 'acc',
  label: 'Club acc.',
  align: 'right',
  mono: true
}, {
  key: 'st',
  label: 'Split'
}];
const ROWS = [{
  rank: '1',
  model: 'caddie-gpt-3b',
  team: 'Loch Analytics',
  sg: '+1.42',
  acc: '0.881',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "public")
}, {
  rank: '2',
  model: 'fairway-lstm',
  team: '@n-park',
  sg: '+1.31',
  acc: '0.874',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "public")
}, {
  rank: '3',
  model: 'baseline-sg',
  team: 'opengolf',
  sg: '+0.00',
  acc: '0.712',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "neutral"
  }, "reference")
}, {
  rank: '4',
  model: 'greenbook-xgb',
  team: 'Turf Lab',
  sg: '-0.18',
  acc: '0.699',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "warning",
    dot: true
  }, "held-out")
}];
function BenchmarkScreen() {
  const [tab, setTab] = React.useState('v3');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--text-h2)',
      margin: 0
    }
  }, "caddie-bench"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '6px 0 0',
      fontSize: 14,
      color: 'var(--text-muted)'
    }
  }, "Shot-recommendation evaluation on frozen splits. Submissions run in the open harness.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    label: "Submissions",
    value: "61",
    delta: "+9 this month",
    icon: "layers"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Test shots",
    value: "40,000",
    icon: "database"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Best SG/round",
    value: "+1.42",
    delta: "+0.11 vs v2",
    icon: "trending-up"
  })), /*#__PURE__*/React.createElement(Tabs, {
    value: tab,
    onChange: setTab,
    variant: "pill",
    style: {
      alignSelf: 'flex-start'
    },
    tabs: [{
      value: 'v3',
      label: 'v3 (current)'
    }, {
      value: 'v2',
      label: 'v2'
    }, {
      value: 'v1',
      label: 'v1'
    }]
  }), /*#__PURE__*/React.createElement(DataTable, {
    columns: COLS,
    rows: ROWS
  }), /*#__PURE__*/React.createElement(Callout, {
    tone: "brand",
    title: "Reproduce any row"
  }, "Every submission ships its container digest and seed. Re-run with ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)'
    }
  }, "og bench run --submission 0x\u2026"), "."));
}
Object.assign(window, {
  BenchmarkScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/explorer/BenchmarkScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/explorer/DatasetDetail.jsx
try { (() => {
const {
  Breadcrumbs,
  Tabs,
  Badge,
  Button,
  Card,
  CodeBlock,
  DataTable,
  Callout,
  Tag,
  Icon,
  Tooltip
} = window.OG;
const SHOT_COLS = [{
  key: 'id',
  label: 'shot_id',
  mono: true,
  muted: true
}, {
  key: 'player',
  label: 'player'
}, {
  key: 'hole',
  label: 'hole',
  align: 'right',
  mono: true
}, {
  key: 'lie',
  label: 'lie'
}, {
  key: 'dist',
  label: 'dist_to_pin_yd',
  align: 'right',
  mono: true
}, {
  key: 'sg',
  label: 'sg',
  align: 'right',
  mono: true
}];
const SHOT_ROWS = [{
  id: '0x9f21a',
  player: 'S. Åberg',
  hole: '7',
  lie: /*#__PURE__*/React.createElement(Tag, null, "fairway"),
  dist: '168.4',
  sg: '+0.41'
}, {
  id: '0x9f21b',
  player: 'S. Åberg',
  hole: '7',
  lie: /*#__PURE__*/React.createElement(Tag, null, "green"),
  dist: '12.1',
  sg: '+0.08'
}, {
  id: '0x9f22c',
  player: 'L. Ko',
  hole: '12',
  lie: /*#__PURE__*/React.createElement(Tag, null, "rough"),
  dist: '201.7',
  sg: '-0.22'
}, {
  id: '0x9f23d',
  player: 'T. Fleetwood',
  hole: '3',
  lie: /*#__PURE__*/React.createElement(Tag, null, "bunker"),
  dist: '44.9',
  sg: '+0.63'
}, {
  id: '0x9f24e',
  player: 'C. Morikawa',
  hole: '18',
  lie: /*#__PURE__*/React.createElement(Tag, null, "tee"),
  dist: '452.0',
  sg: '+0.19'
}];
const SCHEMA_COLS = [{
  key: 'field',
  label: 'Field',
  mono: true
}, {
  key: 'type',
  label: 'Type',
  mono: true,
  muted: true
}, {
  key: 'desc',
  label: 'Description'
}];
const SCHEMA_ROWS = [{
  field: 'shot_id',
  type: 'string',
  desc: 'Stable hash of round, hole and stroke index'
}, {
  field: 'player_id',
  type: 'string',
  desc: 'Registry player identifier'
}, {
  field: 'lie',
  type: 'enum',
  desc: 'tee | fairway | rough | bunker | green | recovery'
}, {
  field: 'dist_to_pin_yd',
  type: 'float32',
  desc: 'Measured at address, laser-corrected where available'
}, {
  field: 'sg',
  type: 'float32',
  desc: 'Strokes gained against the season baseline'
}];
function DatasetDetail({
  id,
  onBack,
  onCopy
}) {
  const [tab, setTab] = React.useState('preview');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Breadcrumbs, {
    items: [{
      label: 'datasets'
    }, {
      label: id.split('/')[0]
    }, {
      label: id.split('/')[1]
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-h3)',
      margin: 0,
      fontWeight: 600
    }
  }, id), /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "live"), /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    icon: "scale"
  }, "Apache-2.0"), /*#__PURE__*/React.createElement(Tooltip, {
    label: "Rows are appended nightly"
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "neutral",
    icon: "clock"
  }, "nightly")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm",
    iconLeft: "copy",
    onClick: onCopy
  }, "Copy pull command"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    iconLeft: "download",
    onClick: () => {}
  }, "Download 612 MB"))), /*#__PURE__*/React.createElement(Tabs, {
    value: tab,
    onChange: setTab,
    tabs: [{
      value: 'preview',
      label: 'Preview',
      count: 5
    }, {
      value: 'schema',
      label: 'Schema',
      icon: 'database'
    }, {
      value: 'api',
      label: 'API',
      icon: 'code'
    }, {
      value: 'issues',
      label: 'Issues',
      count: 3
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 300px',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, tab === 'preview' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(DataTable, {
    columns: SHOT_COLS,
    rows: SHOT_ROWS,
    dense: true
  }), /*#__PURE__*/React.createElement(Callout, {
    tone: "note",
    title: "Preview is a 5-row sample"
  }, "The full partition is 4,218,904 rows across 41 events.")), tab === 'schema' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(DataTable, {
    columns: SCHEMA_COLS,
    rows: SCHEMA_ROWS
  }), /*#__PURE__*/React.createElement(Callout, {
    tone: "warning",
    title: "Schema v2 lands in March"
  }, "v1 columns keep serving until 2027; the migration note is in the changelog.")), tab === 'api' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(CodeBlock, {
    language: "bash",
    filename: "curl",
    code: 'curl https://api.opengolf.ai/v1/datasets/' + id + '/shots \\\n  -H "Accept: application/json" \\\n  -G -d "hole=7" -d "limit=50"'
  }), /*#__PURE__*/React.createElement(CodeBlock, {
    language: "python",
    filename: "shots.py",
    code: 'import opengolf as og\n\nshots = og.load("' + id + '", level="shot")\napproach = shots.filter(lie="fairway")\nprint(approach.sg("approach").top(10))'
  })), tab === 'issues' && /*#__PURE__*/React.createElement(Callout, {
    tone: "brand",
    title: "3 open issues"
  }, "Missing wind data for two events; tracked in opengolf/shotdata#218.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Card, {
    padding: "sm",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-label)',
      fontWeight: 600,
      color: 'var(--text-muted)'
    }
  }, "Details"), [['Rows', '4,218,904'], ['Size', '612 MB'], ['Format', 'parquet'], ['Partitions', '41'], ['Updated', '2 days ago']].map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      color: 'var(--text-body)'
    }
  }, v)))), /*#__PURE__*/React.createElement(Card, {
    padding: "sm",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-label)',
      fontWeight: 600,
      color: 'var(--text-muted)'
    }
  }, "Maintainers"), ['@hollis', '@n-park', '@caddiebot'].map(m => /*#__PURE__*/React.createElement("div", {
    key: m,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 22,
      height: 22,
      borderRadius: 999,
      background: 'var(--green-100)',
      color: 'var(--green-800)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 10,
      fontWeight: 700
    }
  }, m[1].toUpperCase()), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)'
    }
  }, m), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      color: 'var(--text-faint)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "git-pull-request",
    size: 14
  }))))), /*#__PURE__*/React.createElement("span", {
    onClick: onBack,
    style: {
      fontSize: 13,
      cursor: 'pointer',
      color: 'var(--text-link)'
    }
  }, "\u2190 Back to datasets"))));
}
Object.assign(window, {
  DatasetDetail
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/explorer/DatasetDetail.jsx", error: String((e && e.message) || e) }); }

// ui_kits/explorer/DatasetsScreen.jsx
try { (() => {
const {
  Card,
  DataTable,
  Badge,
  Tag,
  StatTile,
  Checkbox,
  Select,
  Icon,
  Button
} = window.OG;
const DATASETS = [{
  id: 'pga-tour/2025',
  rows: '4,218,904',
  size: '612 MB',
  fmt: 'parquet',
  upd: '2d',
  st: ['success', 'live']
}, {
  id: 'lpga/2025',
  rows: '2,904,110',
  size: '438 MB',
  fmt: 'parquet',
  upd: '2d',
  st: ['success', 'live']
}, {
  id: 'dp-world/2025',
  rows: '1,776,320',
  size: '302 MB',
  fmt: 'parquet',
  upd: '5d',
  st: ['success', 'live']
}, {
  id: 'coursemap/greens',
  rows: '1,932',
  size: '88 MB',
  fmt: 'geojson',
  upd: '3w',
  st: ['success', 'live']
}, {
  id: 'amateur/wagr-2025',
  rows: '611,240',
  size: '96 MB',
  fmt: 'parquet',
  upd: '1mo',
  st: ['info', 'beta']
}, {
  id: 'caddie-bench/v3',
  rows: '40,000',
  size: '12 MB',
  fmt: 'jsonl',
  upd: '6d',
  st: ['warning', 'frozen']
}];
function DatasetsScreen({
  onOpen
}) {
  const [tour, setTour] = React.useState(true);
  const cols = [{
    key: 'id',
    label: 'Dataset',
    mono: true
  }, {
    key: 'rows',
    label: 'Rows',
    align: 'right',
    mono: true
  }, {
    key: 'size',
    label: 'Size',
    align: 'right',
    mono: true,
    muted: true
  }, {
    key: 'fmt',
    label: 'Format'
  }, {
    key: 'upd',
    label: 'Updated',
    align: 'right',
    muted: true,
    mono: true
  }, {
    key: 'st',
    label: 'Status'
  }, {
    key: 'go',
    label: '',
    align: 'right'
  }];
  const rows = DATASETS.map(d => ({
    ...d,
    fmt: /*#__PURE__*/React.createElement(Tag, null, d.fmt),
    st: /*#__PURE__*/React.createElement(Badge, {
      tone: d.st[0],
      dot: true
    }, d.st[1]),
    go: /*#__PURE__*/React.createElement("span", {
      onClick: () => onOpen(d.id),
      style: {
        cursor: 'pointer',
        color: 'var(--text-accent)',
        display: 'inline-flex'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "chevron-right",
      size: 16
    }))
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--text-h2)',
      margin: 0
    }
  }, "Datasets"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '6px 0 0',
      fontSize: 14,
      color: 'var(--text-muted)'
    }
  }, "Everything in the public registry. Pull with the client or hit the REST endpoint directly.")), /*#__PURE__*/React.createElement(Button, {
    iconLeft: "download",
    variant: "secondary"
  }, "Mirror registry")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    label: "Shots indexed",
    value: "4,218,904",
    delta: "+12.4% vs 2024",
    icon: "database"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Courses mapped",
    value: "1,932",
    icon: "map-pin"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Seasons",
    value: "18",
    icon: "layers"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Avg. sync lag",
    value: "41",
    unit: "min",
    icon: "clock",
    deltaTone: "neutral"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '214px 1fr',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement(Card, {
    padding: "sm",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-label)',
      fontWeight: 600,
      color: 'var(--text-muted)'
    }
  }, "Filters"), /*#__PURE__*/React.createElement(Select, {
    label: "Season",
    options: ['2025', '2024', '2023'],
    size: "sm"
  }), /*#__PURE__*/React.createElement(Select, {
    label: "Format",
    options: ['parquet', 'geojson', 'jsonl'],
    size: "sm"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement(Checkbox, {
    label: "Tour events",
    checked: tour,
    onChange: setTour
  }), /*#__PURE__*/React.createElement(Checkbox, {
    label: "Amateur",
    checked: false,
    onChange: () => {}
  }), /*#__PURE__*/React.createElement(Checkbox, {
    label: "Frozen splits",
    checked: false,
    onChange: () => {}
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    selected: true,
    onRemove: () => {}
  }, "tour=pga"), /*#__PURE__*/React.createElement(Tag, null, "level=shot"))), /*#__PURE__*/React.createElement(DataTable, {
    columns: cols,
    rows: rows
  })));
}
Object.assign(window, {
  DatasetsScreen,
  DATASETS
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/explorer/DatasetsScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/CommunitySection.jsx
try { (() => {
const {
  Card,
  Button,
  Icon,
  Badge
} = window.OG;
function CommunitySection() {
  const ways = [{
    icon: 'git-pull-request',
    t: 'Ship a parser',
    d: 'Add support for an upstream feed. Start from the parser template and the conformance suite.'
  }, {
    icon: 'map-pin',
    t: 'Survey a course',
    d: 'Trace greens and hazards from public imagery; the review queue merges within a week.'
  }, {
    icon: 'scale',
    t: 'Audit a baseline',
    d: 'Recompute a strokes-gained baseline and open a PR with the notebook attached.'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      maxWidth: 'var(--container-wide)',
      margin: '0 auto',
      padding: '80px 32px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '.85fr 1.15fr',
      gap: 56,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-eyebrow)',
      fontWeight: 600,
      color: 'var(--text-accent)'
    }
  }, "Community"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--text-h1)',
      margin: 0,
      fontWeight: 'var(--weight-bold)',
      lineHeight: 1.15
    }
  }, "Built by people who count their own putts"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--text-body-lg)',
      lineHeight: 1.6,
      color: 'var(--ink-600)',
      textWrap: 'pretty'
    }
  }, "Statisticians, caddies, club coders and a few tour analysts. Governance is a public RFC process \u2014 no committees, no membership fees."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Button, {
    iconLeft: "github",
    onClick: () => {}
  }, "Read the RFCs"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary"
  }, "Join Discord"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 12
    }
  }, ways.map(w => /*#__PURE__*/React.createElement(Card, {
    key: w.t,
    padding: "md",
    interactive: true,
    style: {
      display: 'flex',
      gap: 14,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 38,
      height: 38,
      borderRadius: 'var(--radius-md)',
      background: 'var(--green-50)',
      color: 'var(--green-700)',
      flex: '0 0 auto'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: w.icon,
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: 'var(--text-heading)'
    }
  }, w.t), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--ink-600)',
      lineHeight: 1.55
    }
  }, w.d)), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      color: 'var(--text-faint)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-right",
    size: 16
  })))))));
}
Object.assign(window, {
  CommunitySection
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/CommunitySection.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/DataSection.jsx
try { (() => {
const {
  DataTable,
  Badge,
  Tabs,
  Button,
  Callout,
  Card,
  Icon
} = window.OG;
const COLS = [{
  key: 'name',
  label: 'Dataset',
  mono: true
}, {
  key: 'rows',
  label: 'Rows',
  align: 'right',
  mono: true
}, {
  key: 'size',
  label: 'Size',
  align: 'right',
  mono: true,
  muted: true
}, {
  key: 'lic',
  label: 'Licence'
}, {
  key: 'upd',
  label: 'Updated',
  muted: true
}, {
  key: 'st',
  label: ''
}];
const ROWS = [{
  name: 'pga-tour/2025',
  rows: '4,218,904',
  size: '612 MB',
  lic: /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    icon: "scale"
  }, "Apache-2.0"),
  upd: '2 days ago',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "live")
}, {
  name: 'lpga/2025',
  rows: '2,904,110',
  size: '438 MB',
  lic: /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    icon: "scale"
  }, "Apache-2.0"),
  upd: '2 days ago',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "live")
}, {
  name: 'coursemap/greens',
  rows: '1,932',
  size: '88 MB',
  lic: /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    icon: "scale"
  }, "CC-BY-4.0"),
  upd: '3 weeks ago',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "live")
}, {
  name: 'amateur/wagr-2025',
  rows: '611,240',
  size: '96 MB',
  lic: /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    icon: "scale"
  }, "Apache-2.0"),
  upd: '1 month ago',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "info"
  }, "beta")
}, {
  name: 'caddie-bench/v3',
  rows: '40,000',
  size: '12 MB',
  lic: /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    icon: "scale"
  }, "Apache-2.0"),
  upd: '6 days ago',
  st: /*#__PURE__*/React.createElement(Badge, {
    tone: "warning",
    dot: true
  }, "frozen")
}];
function DataSection() {
  const [tab, setTab] = React.useState('datasets');
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--surface-sunken)',
      borderTop: '1px solid var(--border-subtle)',
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-wide)',
      margin: '0 auto',
      padding: '80px 32px',
      display: 'flex',
      flexDirection: 'column',
      gap: 22
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-eyebrow)',
      fontWeight: 600,
      color: 'var(--text-accent)'
    }
  }, "The registry"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--text-h1)',
      margin: '10px 0 0',
      fontWeight: 'var(--weight-bold)'
    }
  }, "Pull anything, no key needed")), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    iconLeft: "download"
  }, "Mirror the registry")), /*#__PURE__*/React.createElement(Tabs, {
    value: tab,
    onChange: setTab,
    tabs: [{
      value: 'datasets',
      label: 'Datasets',
      count: 5
    }, {
      value: 'mirrors',
      label: 'Mirrors'
    }, {
      value: 'changelog',
      label: 'Changelog',
      icon: 'clock'
    }]
  }), /*#__PURE__*/React.createElement(DataTable, {
    columns: COLS,
    rows: ROWS
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Callout, {
    tone: "brand",
    title: "Everything here is redistributable"
  }, "Attribution is appreciated, not required. Mirrors are listed in the registry manifest."), /*#__PURE__*/React.createElement(Card, {
    padding: "sm",
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--green-600)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "git-pull-request",
    size: 18
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--ink-600)'
    }
  }, "Spotted a bad row? Open an issue against ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13
    }
  }, "opengolf/shotdata"), ".")))));
}
Object.assign(window, {
  DataSection
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/DataSection.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Hero.jsx
try { (() => {
const {
  Button,
  Badge,
  StatTile,
  CodeBlock
} = window.OG;
function Hero({
  onNav
}) {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      position: 'relative',
      backgroundImage: 'var(--grid-plate)',
      backgroundSize: 'var(--grid-cell) var(--grid-cell)',
      backgroundColor: 'var(--paper)',
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-wide)',
      margin: '0 auto',
      padding: '96px 32px 80px',
      display: 'grid',
      gridTemplateColumns: '1.05fr .95fr',
      gap: 64,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 22
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    icon: "flag"
  }, "Open source \xB7 non-profit"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 'var(--text-display-1)',
      fontWeight: 'var(--weight-black)',
      letterSpacing: 'var(--tracking-display)',
      lineHeight: 'var(--leading-tight)',
      color: 'var(--text-heading)',
      margin: 0,
      maxWidth: 560
    }
  }, "Golf data, in the open."), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--text-body-lg)',
      lineHeight: 'var(--leading-relaxed)',
      color: 'var(--ink-600)',
      maxWidth: 520,
      textWrap: 'pretty'
    }
  }, "We build and maintain the shared schemas, parsers and benchmarks the golf world runs on \u2014 shot data, course geometry and model evaluation, free for anyone to use."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement(Button, {
    size: "lg",
    iconRight: "arrow-right",
    onClick: () => onNav('data')
  }, "Browse the datasets"), /*#__PURE__*/React.createElement(Button, {
    size: "lg",
    variant: "secondary",
    iconLeft: "git-branch",
    onClick: () => onNav('projects')
  }, "Contribute")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 26,
      marginTop: 14,
      fontSize: 13,
      color: 'var(--text-muted)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "Apache-2.0"), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "284 contributors"), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "No account required"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(CodeBlock, {
    language: "bash",
    filename: "quickstart",
    code: 'pip install opengolf\n\nimport opengolf as og\nshots = og.load("pga-tour/2025", level="shot")\nshots.sg("approach").top(10)'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    label: "Shots indexed",
    value: "4.2M",
    icon: "database"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Courses mapped",
    value: "1,932",
    icon: "map-pin"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Contributors",
    value: "284",
    icon: "users"
  })))));
}
Object.assign(window, {
  Hero
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/ProjectsGrid.jsx
try { (() => {
const {
  Card,
  Badge,
  Icon,
  Tag
} = window.OG;
const PROJECTS = [{
  name: 'opengolf-schema',
  desc: 'The canonical shot, round and course schema. Versioned, JSON-Schema backed, adopted by 40+ tools.',
  lang: 'JSON Schema',
  stars: '1.2k',
  tags: ['spec', 'stable'],
  status: ['success', 'v2.1.0']
}, {
  name: 'shotdata',
  desc: 'Ingest and normalise tour shot feeds into the open schema. Ships parsers for six upstream formats.',
  lang: 'Python',
  stars: '840',
  tags: ['etl', 'python'],
  status: ['success', 'passing']
}, {
  name: 'coursemap',
  desc: 'Surveyed course geometry — greens, bunkers, fairway polygons — as GeoJSON under a permissive licence.',
  lang: 'GeoJSON',
  stars: '610',
  tags: ['geo', 'data'],
  status: ['info', 'beta']
}, {
  name: 'caddie-bench',
  desc: 'An evaluation harness for shot-recommendation models, with a public leaderboard and frozen test splits.',
  lang: 'Python',
  stars: '392',
  tags: ['benchmark', 'ml'],
  status: ['warning', 'rfc']
}, {
  name: 'og-python',
  desc: 'The reference client. One call from dataset name to a typed dataframe, with local caching.',
  lang: 'Python',
  stars: '1.0k',
  tags: ['client', 'sdk'],
  status: ['success', 'v1.8.2']
}, {
  name: 'strokes-gained',
  desc: 'Reference implementation of strokes-gained baselines, recomputed each season from public data.',
  lang: 'Rust',
  stars: '274',
  tags: ['stats', 'rust'],
  status: ['success', 'passing']
}];
function ProjectsGrid() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      maxWidth: 'var(--container-wide)',
      margin: '0 auto',
      padding: '80px 32px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-eyebrow)',
      fontWeight: 600,
      color: 'var(--text-accent)'
    }
  }, "Initiatives"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--text-h1)',
      margin: '10px 0 0',
      fontWeight: 'var(--weight-bold)'
    }
  }, "Six repositories, one schema")), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 14,
      fontWeight: 600
    }
  }, "All repositories ", /*#__PURE__*/React.createElement(Icon, {
    name: "arrow-up-right",
    size: 15
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: 16
    }
  }, PROJECTS.map(p => /*#__PURE__*/React.createElement(Card, {
    key: p.name,
    interactive: true,
    padding: "md",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--green-600)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "flag",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 14,
      fontWeight: 600,
      color: 'var(--text-heading)'
    }
  }, p.name), /*#__PURE__*/React.createElement(Badge, {
    tone: p.status[0],
    dot: true,
    style: {
      marginLeft: 'auto'
    }
  }, p.status[1])), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 14,
      lineHeight: 1.55,
      color: 'var(--ink-600)',
      textWrap: 'pretty'
    }
  }, p.desc), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      marginTop: 'auto',
      paddingTop: 8,
      alignItems: 'center'
    }
  }, p.tags.map(t => /*#__PURE__*/React.createElement(Tag, {
    key: t
  }, t)), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 12,
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-mono)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "star",
    size: 13
  }), p.stars))))));
}
Object.assign(window, {
  ProjectsGrid,
  PROJECTS
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/ProjectsGrid.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/SiteFooter.jsx
try { (() => {
const {
  Logo,
  Icon,
  Input,
  Button
} = window.OG;
function SiteFooter() {
  const cols = [['Projects', ['opengolf-schema', 'shotdata', 'coursemap', 'caddie-bench']], ['Data', ['Registry', 'Mirrors', 'Licences', 'Changelog']], ['Docs', ['Quickstart', 'Python client', 'REST API', 'RFC process']]];
  return /*#__PURE__*/React.createElement("footer", {
    className: "og-inverse",
    style: {
      background: 'var(--green-900)',
      color: 'var(--green-100)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-wide)',
      margin: '0 auto',
      padding: '64px 32px 28px',
      display: 'grid',
      gridTemplateColumns: '1.4fr repeat(3,1fr) 1.2fr',
      gap: 40
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--paper)',
      padding: '10px 14px',
      borderRadius: 'var(--radius-md)',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    height: 20
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 13,
      lineHeight: 1.6,
      color: 'var(--green-200)',
      maxWidth: 230
    }
  }, "A non-profit maintaining open infrastructure for golf data."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      color: 'var(--green-200)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "github",
    size: 17,
    basePath: "../../assets/brand-icons"
  }), /*#__PURE__*/React.createElement(Icon, {
    name: "discord",
    size: 17,
    basePath: "../../assets/brand-icons"
  }))), cols.map(([h, items]) => /*#__PURE__*/React.createElement("div", {
    key: h,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-label)',
      fontWeight: 600,
      color: 'var(--green-300)'
    }
  }, h), items.map(i => /*#__PURE__*/React.createElement("a", {
    key: i,
    href: "#",
    style: {
      fontSize: 13,
      color: 'var(--green-100)',
      textDecoration: 'none'
    }
  }, i)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-label)',
      fontWeight: 600,
      color: 'var(--green-300)'
    }
  }, "Changelog"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--green-200)',
      lineHeight: 1.55
    }
  }, "Monthly notes on schema changes and new datasets."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Input, {
    placeholder: "you@club.org",
    size: "sm"
  }), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "accent"
  }, "Subscribe")))), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-wide)',
      margin: '0 auto',
      padding: '18px 32px 34px',
      borderTop: '1px solid rgba(255,255,255,.10)',
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 12,
      color: 'var(--green-300)',
      fontFamily: 'var(--font-mono)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\xA9 2026 opengolf.ai \u2014 Apache-2.0 unless noted"), /*#__PURE__*/React.createElement("span", null, "status: all systems nominal")));
}
Object.assign(window, {
  SiteFooter
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/SiteFooter.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/SiteHeader.jsx
try { (() => {
const {
  Button,
  Logo,
  Icon
} = window.OG;
function SiteHeader({
  page,
  onNav
}) {
  const links = [['projects', 'Projects'], ['data', 'Data'], ['docs', 'Docs'], ['community', 'Community']];
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 20,
      background: 'rgba(249,250,244,.86)',
      backdropFilter: 'var(--blur-panel)',
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-wide)',
      margin: '0 auto',
      padding: '0 32px',
      height: 66,
      display: 'flex',
      alignItems: 'center',
      gap: 36
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      cursor: 'pointer'
    },
    onClick: () => onNav('home')
  }, /*#__PURE__*/React.createElement(Logo, {
    height: 22
  })), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      gap: 26,
      marginRight: 'auto'
    }
  }, links.map(([k, l]) => /*#__PURE__*/React.createElement("a", {
    key: k,
    onClick: () => onNav(k),
    style: {
      fontSize: 14,
      fontWeight: page === k ? 600 : 500,
      color: page === k ? 'var(--text-heading)' : 'var(--text-muted)',
      cursor: 'pointer',
      textDecoration: 'none'
    }
  }, l))), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      fontSize: 13,
      color: 'var(--text-muted)',
      textDecoration: 'none'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "github",
    size: 16,
    basePath: "../../assets/brand-icons"
  }), " 3.1k"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "secondary",
    iconLeft: "book-open",
    onClick: () => onNav('docs')
  }, "Docs"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    iconRight: "arrow-right",
    onClick: () => onNav('data')
  }, "Get the data")));
}
Object.assign(window, {
  SiteHeader
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/SiteHeader.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Logo = __ds_scope.Logo;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.CodeBlock = __ds_scope.CodeBlock;

__ds_ns.DataTable = __ds_scope.DataTable;

__ds_ns.StatTile = __ds_scope.StatTile;

__ds_ns.Callout = __ds_scope.Callout;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Breadcrumbs = __ds_scope.Breadcrumbs;

__ds_ns.Tabs = __ds_scope.Tabs;

})();
