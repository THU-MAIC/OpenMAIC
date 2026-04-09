# Slate Brand Guidelines

This document outlines the visual identity and design principles for **Slate**.

## Color Palette

Our brand colors are vibrant and high-contrast, designed to be both playful and professional.

| Color Name | Hex Code | Usage |
| :--- | :--- | :--- |
| **Foreground / Primary Tek** | `#073B4C` | Main text, borders, and dark elements |
| **Primary / Action** | `#EF476F` | Call-to-action buttons, high-impact highlights |
| **Secondary / Accents** | `#FFD166` | Background shapes, secondary highlights |
| **Accent / Info** | `#118AB2` | Supplementary information, icons |
| **Success / Positive** | `#06D6A0` | Success states, positive feedback |
| **Creative / Purple** | `#8338EC` | Decorative floating elements |
| **Vibrant Orange** | `#FF6B35` | Additional accent color for contrast |

## Decorative Elements

### Floating Blobs

The "Floating Blobs" are a key visual motif in Slate, providing depth and a playful, interactive feel to our backgrounds.

- **Animation**: Blobs should use the `floating-shape` or `floating-shape-reverse` animations defined in `globals.css`.
- **Styling**: They consist of various geometric shapes (circles, rounded squares, etc.) with thick borders (`border-4` or `border-3`) and reduced opacity (`opacity-25` to `opacity-50`).
- **Placement**: Primarily used in the background of "Prompt Pages" (Landing Page) and other high-level entry points.
- **Implementation Example**:
  ```tsx
  <div className="floating-shape absolute top-[8%] left-[4%] w-16 h-16 bg-[#FFD166] rounded-full border-4 border-[#073B4C] opacity-50" />
  ```

## Design Principles

1.  **Playful yet Structured**: Use "Neubrutalist" elements like thick borders and offset shadows (`shadow-[8px_8px_0_#073b4c]`) balanced with soft gradients.
2.  **Premium Aesthetics**: Avoid default browser colors. Use the curated palette above.
3.  **Dynamic Interactions**: Use micro-animations (like the floating blobs) to make the interface feel "alive".
