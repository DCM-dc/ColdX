// This factory is serialized into DSH's client module. Keep every dependency inside it.
export function createBrandComponents(React, assets) {
  const h = React.createElement;

  function Mark({ size = 28, className = '', decorative = false } = {}) {
    return h('img', {
      className: `cx-brand-symbol${className ? ` ${className}` : ''}`,
      src: assets.symbolHref, width: size, height: size,
      alt: decorative ? '' : 'ColdX', 'aria-hidden': decorative ? true : undefined,
      draggable: false,
    });
  }

  function Name() {
    return h('span', { className: 'cx-brand-name' }, 'ColdX');
  }

  function HeroBrand() {
    return h('div', { className: 'cx-brand-hero' },
      h('div', { className: 'cx-brand-lockup' },
        h(Mark, { size: 48, decorative: true }),
        h('h1', { className: 'cx-brand-hero-name' }, 'ColdX')));
  }

  return { Mark, Name, HeroBrand, faviconHref: assets.faviconHref };
}
