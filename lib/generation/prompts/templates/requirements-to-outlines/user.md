Please generate scene outlines based on the following course requirements.

---

## User Requirements

{{requirement}}

---

{{userProfile}}

## Course Language

**Target language** (language being learned): {{language}}
**Explanation language** (language for all titles, descriptions, labels, and instructions): {{explanationLanguage}}

- Write all titles, descriptions, key points, and instructions in **{{explanationLanguage}}**
- When the target language is different from the explanation language, include target-language vocabulary words or phrases as-is (untranslated) within the English explanation text — for example: "Practice the word *šuo* (dog)" in an English description
- Speech/audio actions should speak only the target-language words and phrases

---

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Available Images

{{availableImages}}

### Web Search Results

{{researchContext}}

{{teacherContext}}

---

## Output Requirements

Please automatically infer the following from user requirements:

- Course topic and core content
- Target audience and difficulty level
- Course duration (default 15-30 minutes if not specified)
- Teaching style (formal/casual/interactive/academic)
- Visual style (minimal/colorful/professional/playful)

Then output a JSON array containing all scene outlines. Each scene must include:

```json
{
  "id": "scene_1",
  "type": "slide" or "quiz" or "interactive",
  "title": "Scene Title",
  "description": "Teaching purpose description",
  "keyPoints": ["Point 1", "Point 2", "Point 3"],
  "order": 1
}
```

### Special Notes

1. **quiz scenes must include quizConfig**:
   ```json
   "quizConfig": {
     "questionCount": 2,
     "difficulty": "easy" | "medium" | "hard",
     "questionTypes": ["single", "multiple"]
   }
   ```
2. **If images are available**, add `suggestedImageIds` to relevant slide scenes
3. **Interactive scenes**: If a concept benefits from hands-on simulation/visualization, use `"type": "interactive"` with an `interactiveConfig` object containing `conceptName`, `conceptOverview`, `designIdea`, and `subject`. Limit to 1-2 per course.
4. **Scene count**: Based on inferred duration, typically 1-2 scenes per minute
5. **Quiz placement**: Recommend inserting a quiz every 3-5 slides for assessment
6. **Language**: Write all generated text (titles, descriptions, keyPoints) in {{explanationLanguage}}. Target-language words being taught ({{language}}) should appear inline in their original form
7. **If no suitable PDF images exist** for a slide scene that would benefit from visuals, add `mediaGenerations` array with image generation prompts. Write prompts in English. Use `elementId` format like "gen_img_1", "gen_img_2" — IDs must be **globally unique across all scenes** (do NOT restart numbering per scene). To reuse a generated image in a different scene, reference the same elementId without re-declaring it in mediaGenerations. Each generated image should be visually distinct — avoid near-identical media across slides.
8. **If web search results are provided**, reference specific findings and sources in scene descriptions and keyPoints. The search results provide up-to-date information — incorporate it to make the course content current and accurate.

{{mediaGenerationPolicy}}

Please output JSON array directly without additional explanatory text.
