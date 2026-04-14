# Walkthrough - Cluster-Based Portrait Reflow (4:5)

I've implemented a major upgrade to the mobile portrait reflow algorithm to ensure that complex slide layouts (like headers on background stripes or text on boxes) remain visually intact while stacking vertically.

## Key Changes

### 1. Smart Clustering Algorithm
- **Connectivity Check**: The reflow engine now identifies "clusters" of elements that overlap in the original landscape design.
- **Unit Scaling**: Elements within a cluster (e.g., a text header and its blue underline) are moved and scaled as a single unit. This prevents them from separating or overlapping incorrectly during the reflow process.
- **Z-Order Preservation**: Inside each cluster, the original layering (which element is on top of which) is strictly maintained.

### 2. New 4:5 Portrait Aspect Ratio
- Updated the target portrait ratio from `9:16` to **`4:5`** (1.25 ratio).
- This provides a wider canvas that is better suited for slide content and leaves more designated space for captions at the bottom of the screen.

### 3. Refined Scaling & Font Boosting
- **Full-Width Intelligent Scaling**: Clusters that span the full width of the original slide (like background stripes) are automatically scaled to span the full width of the portrait view (800px).
- **Proportional Spacing**: Clusters are stacked vertically with consistent 40px gaps to ensure a clean, readable flow.
- **Optimized Font Boosting**: Applied a `1.6x` font size boost to text elements within clusters to ensure legibility on mobile screens without causing excessive line wrapping.

## Visual Improvements
- **Layering Fixed**: background shapes (like the blue box mentioned) will now correctly stay behind their associated text.
- **Header Alignment**: Header elements are clustered together, preventing images from "jumping" in between parts of a title.

## Verification
- Cleaned up lint errors related to missing constants and helper functions.
- Verified that the `4:5` ratio is correctly synced to the global CanvasStore for consistent layout calculation across the app.
