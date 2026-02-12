---
name: frontend-mockup
description: "Generate 1 to 4 self-contained HTML mockup variants for a frontend design, each with a distinct aesthetic direction. Use when the user wants to explore visual options, compare alternatives, or pick a direction before committing to implementation."
---

# Frontend Mockup Skill

Generate multiple self-contained HTML mockups so the user can compare distinct aesthetic directions side by side before committing to one. This is the **exploration** phase of design: breadth over depth, options over finality.

## When to Use

Use this skill when the user wants to:
- See multiple visual directions before choosing one
- Compare layout, color, or typographic approaches for a page or component
- Explore design options for a new feature, redesign, or landing page
- Get a feel for how different aesthetics would land before writing production code

Do **not** use this skill when the user already knows what they want and just needs it built. Use the `frontend-design` skill for that.

## Inputs to Gather (or Assume)

Before generating mockups, identify:
- **Subject**: What is being designed? (page, component, screen, flow)
- **Purpose and audience**: What problem does this UI solve? Who uses it?
- **Scope**: How many mockups? (default: 3; range: 1 to 4)
- **Constraints**: Required content, branding, framework preferences, accessibility needs
- **Direction hints**: Any aesthetic preferences, references, or directions to avoid?

If the user did not provide enough context, ask **2 to 3 focused questions**. Do not over-interview; make reasonable assumptions and state them.

## Workflow

### 1. Choose Distinct Directions

Each mockup must take a **clearly different** aesthetic direction. The goal is contrast, not subtle variation. Pick directions that are meaningfully apart from each other.

Example direction pool (pick from these or invent your own):
- Brutalist / raw / utilitarian
- Editorial / magazine / typographic
- Luxury / refined / minimal
- Retro-futuristic / cyber / neon
- Art-deco / geometric / ornamental
- Handcrafted / organic / textured
- Swiss / clean / systematic
- Maximalist / dense / layered
- Playful / rounded / colorful
- Industrial / monospaced / stark

If the user hinted at a preference, make one mockup match that hint and let the others diverge.

### 2. Define Each Direction

For each mockup, briefly define:
1. **Direction name** and one-sentence vibe
2. **Typography** pick (display + body, sourced from Google Fonts or similar CDN)
3. **Color system** (3 to 5 colors as CSS variables)
4. **Layout approach** (grid rhythm, spacing, hierarchy)
5. **Signature detail** (one memorable visual element: a texture, a motion, a shape, a border treatment)

Present these definitions to the user as a short summary table or list **before** writing code, unless the user asked you to just go ahead.

### 3. Generate Mockup Files

Each mockup is a **single, self-contained HTML file** with all CSS and JS inlined. The files must:
- Open in any browser with no build step, no server, no dependencies (except CDN font links)
- Use the same content and structure so the comparison is apples-to-apples
- Be saved to a `mockups/` directory (or a location the user specifies)
- Follow a clear naming convention: `mockup-1-<direction>.html`, `mockup-2-<direction>.html`, etc.

File structure example:
```
mockups/
  mockup-1-brutalist.html
  mockup-2-editorial.html
  mockup-3-luxury.html
```

### 4. Present the Comparison

After generating the files, provide a short summary:
- List each mockup with its direction name, one-line description, and file path
- Highlight what makes each one distinct
- Note any tradeoffs (e.g., "Mockup 2 is text-heavy and may need real copy to shine")
- Tell the user they can open the files in a browser to compare

### 5. Apply the Chosen Direction

When the user picks a mockup:
- Ask if they want to refine it further (tweak colors, layout, details) or apply it as-is
- If the change targets an existing project, adapt the mockup code into the project's framework, file structure, and conventions
- If the user wants production-quality implementation, follow the principles from the `frontend-design` skill (semantic HTML, accessibility, responsive, tokenized styling)
- Clean up or remove the mockup files if the user no longer needs them

## Implementation Rules for Mockups

Even though these are exploratory, they should still be **high quality visually**:
- Use real (or realistic) content, not lorem ipsum. Invent plausible headlines, labels, and data.
- Each mockup should feel like a complete, polished snapshot, not a wireframe.
- Include at least one interactive moment per mockup (hover state, transition, scroll effect) to convey how the direction would feel in motion.
- Honor `prefers-reduced-motion`.
- Use Google Fonts or Bunny Fonts CDN links for typography. Do not rely on system fonts or defaults.

## Aesthetic Standards

Carry forward the same aesthetic rigor as the `frontend-design` skill:

### Typography
- Each mockup uses a **different** display font to reinforce its direction
- Clear hierarchy: size, weight, spacing, casing
- No default or generic font choices (no Arial, no system-ui as the design font)

### Color
- Commit to a palette. Each mockup's palette should be visually distinct from the others.
- Check legibility and contrast.
- Define colors as CSS custom properties at the top of each file.

### Layout
- Use CSS Grid or Flexbox. No float hacks.
- Each mockup should demonstrate a different layout personality (e.g., one uses asymmetric grid, another uses centered single-column, another uses dense card layout).

### Detail
- At least one signature visual detail per mockup (texture, pattern, border style, clip-path, shadow treatment, etc.)
- No unmotivated decoration. Every detail should serve the direction.

## Avoid

- Mockups that only differ in color but share the same layout and typography
- Generic, safe, middle-of-the-road options that all look the same
- Wireframe-level fidelity. These should look designed, not sketched.
- Lorem ipsum or placeholder rectangles where content should be
- More than 4 mockups (diminishing returns; 2 to 3 is usually the sweet spot)

## Quality Checklist (Self-validate Before Delivering)

For each mockup:
- [ ] Direction is clearly named and visually distinct from the others
- [ ] Typography is intentional and sourced from a web font CDN
- [ ] Color palette is cohesive, legible, and defined as CSS variables
- [ ] Layout feels purposeful and different from the other mockups
- [ ] At least one signature detail or interaction is present
- [ ] File is self-contained HTML that opens in a browser with no setup
- [ ] Content is realistic, not placeholder

For the set as a whole:
- [ ] The mockups offer genuinely different visual directions
- [ ] The comparison summary is clear and actionable
- [ ] The user knows how to view, choose, and apply

**Remember:** the point of mockups is to help the user see real options. Make each one bold enough that the choice is obvious, not a coin flip between near-identical siblings.
