// ============================================
// mermaid-config.js - Mermaid Theme Configuration
// ============================================

/**
 * Label type size for every diagram type, in CSS pixels.
 *
 * One step above the 13px body copy in styles.css: diagram labels sit on top of
 * shapes and connector lines, so they need slightly more weight than running
 * text to stay legible. Declared once because it has to be repeated in three
 * places (top-level `fontSize`, and `fontSize` in each theme's variables) that
 * must not drift apart.
 */
const MERMAID_FONT_PX = 14;

/**
 * Light theme variables for Mermaid diagrams
 */
const MERMAID_LIGHT_THEME = {
  primaryColor: '#279EA7',
  primaryTextColor: '#1F3244',
  primaryBorderColor: '#279EA7',
  lineColor: '#279EA7',
  secondaryColor: '#1F3244',
  tertiaryColor: '#f5f5f5',
  background: '#ffffff',
  mainBkg: '#ffffff',
  secondBkg: '#f5f5f5',
  textColor: '#1F3244',
  border1: '#d0d0d0',
  border2: '#d0d0d0',
  fontSize: MERMAID_FONT_PX + 'px',
  fontFamily: 'Fira Code Local, Fira Code, Segoe UI, Calibri, Arial, sans-serif'
};

/**
 * Dark theme variables for Mermaid diagrams
 */
const MERMAID_DARK_THEME = {
  primaryColor: '#3DBDC6',
  primaryTextColor: '#e8e8e8',
  primaryBorderColor: '#3DBDC6',
  lineColor: '#3DBDC6',
  secondaryColor: '#2d2d2d',
  tertiaryColor: '#1a1a1a',
  background: '#242424',
  mainBkg: '#242424',
  secondBkg: '#2d2d2d',
  textColor: '#e8e8e8',
  border1: '#404040',
  border2: '#404040',
  fontSize: MERMAID_FONT_PX + 'px',
  fontFamily: 'Fira Code Local, Fira Code, Segoe UI, Calibri, Arial, sans-serif'
};

/**
 * Layout geometry shared by every diagram type.
 *
 * Mermaid's defaults draw large shapes around small text: measured on a
 * representative flowchart the label covered only 39.9% of its node box, and a
 * sequence-diagram actor box was 150x65px to hold the word "User" (6.3% fill).
 * A diagram therefore consumed a lot of screen space while still being hard to
 * read - the two complaints are the same problem seen from opposite ends.
 *
 * The instinctive fix - just raise the font size - measurably makes it worse:
 * at 15px with default spacing the flowchart canvas grew 19% while the fill
 * ratio moved only 39.9% -> 42.8%, because mermaid sizes shapes from the text
 * plus fixed padding. The effective levers are the padding and spacing
 * constants, and for sequence diagrams the fixed actor box `width`/`height`.
 *
 * These values were chosen from a measured sweep (see the commit for the full
 * table). Against mermaid's defaults they give, per diagram:
 *   flowchart  fill 39.9% -> 59.5%, canvas area -21.2%
 *   sequence   fill  6.3% ->  9.3%, canvas area -44.2%
 *   class      fill 49.6% -> 61.8%, canvas area -14.2%
 * with no label overflowing its shape in any tested diagram.
 */
const MERMAID_FLOWCHART = {
  // Default 15. This is the gap between a label and its shape edge, and is the
  // single biggest contributor to oversized boxes.
  padding: 6,
  nodeSpacing: 32, // default 50
  rankSpacing: 38, // default 50
  wrappingWidth: 200,
  htmlLabels: true,
};

const MERMAID_SEQUENCE = {
  // Actor boxes are a fixed size in mermaid, not text-derived, so they are the
  // whole reason a one-word participant gets a 150x65 box.
  width: 118, // default 150
  height: 42, // default 65
  actorMargin: 32, // default 50
  boxTextMargin: 3,
  boxMargin: 8,
  actorFontSize: 15,
  messageFontSize: 14,
  noteFontSize: 13,
};

/**
 * Get full Mermaid configuration object
 * @param {boolean} isDark - Whether dark mode is enabled
 * @returns {object} Mermaid configuration object
 */
function getMermaidConfig(isDark) {
  return {
    startOnLoad: true,
    theme: isDark ? 'dark' : 'default',
    // Declared at the top level as well as in themeVariables: mermaid uses the
    // top-level value for layout maths and themeVariables for the emitted CSS,
    // and leaving the top-level one unset let some diagram types fall back to
    // their own default (sequence diagrams rendered at 16px while flowcharts
    // rendered at 13px, an inconsistency visible side by side in one document).
    fontSize: MERMAID_FONT_PX,
    themeVariables: isDark ? MERMAID_DARK_THEME : MERMAID_LIGHT_THEME,
    flowchart: MERMAID_FLOWCHART,
    sequence: MERMAID_SEQUENCE
  };
}

// Export for use in other modules
module.exports = {
  MERMAID_LIGHT_THEME,
  MERMAID_DARK_THEME,
  MERMAID_FLOWCHART,
  MERMAID_SEQUENCE,
  MERMAID_FONT_PX,
  getMermaidConfig
};
