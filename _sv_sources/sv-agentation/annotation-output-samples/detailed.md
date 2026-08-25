## Page Feedback: /dashboard
**Viewport:** 1512x738
**URL:** https://myapp.com/dashboard
**User Agent:** Chrome/120.0

---

### 1. button.submit-btn

**Selector:** `.form-container > .actions > button.submit-btn`
**Source:** src/components/FormActions.tsx:42:5
**Classes:** `.submit-btn`, `.primary`
**React:** `<App> <Dashboard> <FormActions> <SubmitButton>`
**Bounding box:** x:450, y:320, 120x40px
**Nearby text:** "Cancel Save Changes"

**Issue:** Button text should say "Save" not "Submit"

---

### 2. span.nav-label

**Selector:** `.sidebar > nav > .nav-item > span`
**Source:** src/components/Sidebar.tsx:28:12
**Classes:** `.nav-label`
**React:** `<App> <Sidebar> <NavItem>`
**Selected text:** "Settigns"
**Nearby text:** "Dashboard Settigns Profile"

**Issue:** Typo - should be "Settings"

---

**Search tips:** Use the class names, React components, or selectors above to find these elements. Try `grep -r "SubmitButton"` or `grep -r "className.*submit-btn"`.