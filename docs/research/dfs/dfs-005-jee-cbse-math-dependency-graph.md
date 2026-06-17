# DFS-005 — JEE/CBSE Mathematics Dependency Graph

**Date:** 2026-06-04  
**Research Phase:** DFS — deep-dive into multi-year math prerequisites

---

## 1. Class 10 → 11 → 12 Staircase

```
Class 10
├── Real Numbers → Sets & Relations (11)
├── Polynomials → Complex Numbers, Quadratic Equations (11)
├── Linear Equations → Matrices & Determinants (12)
├── Quadratic Equations → Complex Numbers, Inequalities (11)
├── Arithmetic/Geometric Progressions → Sequences & Series (11)
├── Coordinate Geometry → Straight Lines, Circles, Conics (11)
├── Similarity/Triangles → Trigonometry identities (11)
├── Trigonometry → Inverse trig, trig equations (11)
├── Mensuration (2D/3D) → 3D Geometry, Vectors (12)
├── Statistics/Probability → Probability (12)

Class 11
├── Sets, Relations, Functions
├── Complex Numbers & Quadratic Equations
├── Permutations & Combinations
├── Binomial Theorem
├── Sequences & Series
├── Straight Lines
├── Conic Sections
├── Introduction to 3D Geometry
├── Limits & Derivatives
├── Statistics
├── Probability

Class 12
├── Relations & Functions (advanced)
├── Inverse Trigonometric Functions
├── Matrices & Determinants
├── Continuity & Differentiability
├── Application of Derivatives
├── Integrals
├── Application of Integrals
├── Differential Equations
├── Vector Algebra
├── Three Dimensional Geometry
├── Linear Programming
├── Probability
```

---

## 2. JEE Weightage (Mathematics)

| Topic Area | JEE Main Weightage | JEE Advanced Weightage |
|------------|--------------------|------------------------|
| Calculus | High | 30–35 % |
| Coordinate Geometry | ~17 % | 20–25 % |
| Algebra | High | 20–25 % |
| Vectors & 3D Geometry | ~10 % | 10–12 % |
| Trigonometry | Moderate | 5–7 % |
| Probability & Statistics | Moderate | 5–8 % |

Sources: Indian Express, Testbook, Super Tutor.[^27][^28][^29]

---

## 3. Dependency Rules for Adaptive Engine

| Before Student Can Learn | Must Master |
|--------------------------|-------------|
| Complex Numbers | Polynomials, Quadratic Equations |
| Matrices & Determinants | Linear Equations (2 vars), basic algebra |
| Calculus (Limits) | Functions, trigonometry |
| Application of Derivatives | Limits, differentiation |
| Integrals | Differentiation, trigonometric identities |
| 3D Geometry / Vectors | Coordinate geometry, mensuration |
| Probability (12) | Class 10 probability, permutations & combinations |

---

## 4. Product Implication

The `curriculum-graph` should support:

- **Multi-grade nodes** (class_9 → class_12).
- **Cross-board tags** (CBSE, state boards, JEE foundation).
- **Prerequisite edges** with strength weights.
- **Difficulty ceilings** per track (board vs JEE).
