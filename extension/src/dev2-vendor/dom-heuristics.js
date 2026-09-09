/**
 * Helper to resolve nearby label text for a given DOM element.
 * Checks in order: associated <label for=id> or parent <label>, aria-label, placeholder,
 * and closest preceding sibling text node within the same parent.
 * @param {HTMLElement} el
 * @returns {string|null}
 */
function getNearbyLabelText(el) {
  if (!el || typeof el.getAttribute !== 'function') {
    return null;
  }

  if (el.labels && el.labels.length > 0) {
    for (let i = 0; i < el.labels.length; i++) {
      const text = (el.labels[i].textContent || '').trim();
      if (text) return text;
    }
  }

  if (el.id && el.ownerDocument && typeof el.ownerDocument.querySelector === 'function') {
    try {
      const escapeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
      const labelEl = el.ownerDocument.querySelector(`label[for="${escapeId}"]`);
      if (labelEl) {
        const text = (labelEl.textContent || '').trim();
        if (text) return text;
      }
    } catch (e) {
      // Fallback if querySelector fails
    }
  }

  if (typeof el.closest === 'function') {
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const text = (parentLabel.textContent || '').trim();
      if (text) return text;
    }
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim();
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) {
    return placeholder.trim();
  }

  let curr = el.previousSibling;
  while (curr) {
    const text = (curr.textContent || '').trim();
    if (text) {
      return text;
    }
    curr = curr.previousSibling;
  }

  return null;
}

/**
 * Classifies a DOM element based on form heuristics and sensitivity rules.
 * Order of evaluation: PASSWORD -> CARD_NUMBER -> EMAIL -> AMOUNT -> PHONE -> NAME -> UNKNOWN
 * @param {HTMLElement} el
 * @returns {{ tag: string, role: string|null, label_text: string|null, is_sensitive: boolean, sensitivity_type: "PASSWORD"|"CARD_NUMBER"|"EMAIL"|"PHONE"|"NAME"|"AMOUNT"|"UNKNOWN"|null }}
 */
export function classifyElement(el) {
  if (!el || typeof el.getAttribute !== 'function') {
    return {
      tag: '',
      role: null,
      label_text: null,
      is_sensitive: false,
      sensitivity_type: 'UNKNOWN'
    };
  }

  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const role = el.getAttribute('role') || null;
  const typeAttr = (el.getAttribute('type') || '').toLowerCase();
  const autocompleteAttr = (el.getAttribute('autocomplete') || '').toLowerCase();
  const placeholderAttr = (el.getAttribute('placeholder') || '').toLowerCase();

  // Hard exclusion for buttons
  if (tag === 'button' || typeAttr === 'submit' || typeAttr === 'button' || role === 'button') {
    return {
      tag: 'button',
      role: 'button',
      label_text: el.innerText || el.textContent || null,
      is_sensitive: false,
      sensitivity_type: null
    };
  }

  const label_text = getNearbyLabelText(el);
  const elText = (el.innerText || el.textContent || '').trim();

  // 1. Password
  if (typeAttr === 'password') {
    return {
      tag,
      role,
      label_text,
      is_sensitive: true,
      sensitivity_type: 'PASSWORD'
    };
  }

  // 2. Card Number
  if (autocompleteAttr.includes('cc-number')) {
    return {
      tag,
      role,
      label_text,
      is_sensitive: true,
      sensitivity_type: 'CARD_NUMBER'
    };
  }

  // 3. Email
  if (autocompleteAttr.includes('email') || typeAttr === 'email') {
    return {
      tag,
      role,
      label_text,
      is_sensitive: true,
      sensitivity_type: 'EMAIL'
    };
  }

  // 4. Amount (Checked BEFORE Phone to prioritize price/total displays over ambiguous nearby sibling text)
  if (
    (label_text && /amount|price|total/i.test(label_text)) ||
    (placeholderAttr && /amount|price|total/i.test(placeholderAttr)) ||
    (elText && /amount|price|total|\$\d/i.test(elText))
  ) {
    return {
      tag,
      role,
      label_text: label_text || (elText || null),
      is_sensitive: true,
      sensitivity_type: 'AMOUNT'
    };
  }

  // 5. Phone
  if (
    autocompleteAttr.includes('tel') ||
    typeAttr === 'tel' ||
    (label_text && /phone|mobile|contact number/i.test(label_text)) ||
    (placeholderAttr && /phone|mobile|contact number/i.test(placeholderAttr))
  ) {
    return {
      tag,
      role,
      label_text,
      is_sensitive: true,
      sensitivity_type: 'PHONE'
    };
  }

  // 6. Name
  if (autocompleteAttr.includes('name') || (label_text && /name/i.test(label_text))) {
    return {
      tag,
      role,
      label_text,
      is_sensitive: true,
      sensitivity_type: 'NAME'
    };
  }

  return {
    tag,
    role,
    label_text,
    is_sensitive: false,
    sensitivity_type: 'UNKNOWN'
  };
}

let elementIdCounter = 0;

/**
 * Generates a stable selector-like ID for an element.
 * @param {HTMLElement} el
 * @returns {string}
 */
export function getElementId(el) {
  if (!el || typeof el.getAttribute !== 'function') {
    return '';
  }

  if (el.id && el.id.trim() !== '') {
    return el.id;
  }

  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-ext-id')) {
    return el.getAttribute('data-ext-id');
  }

  const generatedId = `ext-el-${Date.now()}-${++elementIdCounter}`;
  if (typeof el.setAttribute === 'function') {
    el.setAttribute('data-ext-id', generatedId);
  }
  return generatedId;
}
