
# AI Repo Context

## Frameworks
['Node.js', 'FastAPI']

## Repo Map

./
  tsconfig.json
  package.json
  README.md
  next.config.ts
  .env.example
  ai_repo_brain.py
  docker-compose.yml
  components.json
  vercel.json
  .dockerignore
  postcss.config.mjs
  .prettierrc
  pnpm-workspace.yaml
  .prettierignore
  Dockerfile
  .nvmrc
  .gitignore
  eslint.config.mjs
  LICENSE
  pnpm-lock.yaml
.serena/
    project.yml
    project.local.yml
    .gitignore
cache/
vue/
typescript/
        document_symbols.pkl
        raw_document_symbols.pkl
python/
        document_symbols.pkl
        raw_document_symbols.pkl
memories/
      tech_stack.md
      code_style.md
      task_completion_checklist.md
      suggested_commands.md
      codebase_structure.md
      project_overview.md
community/
    feishu.md
configs/
    latex.ts
    element.ts
    animation.ts
    theme.ts
    font.ts
    image-clip.ts
    chart.ts
    storage.ts
    shapes.ts
    symbol.ts
    hotkey.ts
    mime.ts
    lines.ts
app/
    favicon.ico
    globals.css
    page.tsx
    layout.tsx
    apple-icon.png
classroom/
[id]/
        page.tsx
generation-preview/
      page.tsx
      layout.tsx
      types.ts
components/
        visualizers.tsx
api/
generate-classroom/
        route.ts
[jobId]/
          route.ts
verify-model/
        route.ts
classroom/
        route.ts
pbl/
chat/
          route.ts
verify-pdf-provider/
        route.ts
proxy-media/
        route.ts
chat/
        route.ts
verify-image-provider/
        route.ts
server-providers/
        route.ts
azure-voices/
        route.ts
generate/
scene-outlines-stream/
          route.ts
agent-profiles/
          route.ts
tts/
          route.ts
scene-content/
          route.ts
video/
          route.ts
scene-actions/
          route.ts
image/
          route.ts
quiz-grade/
        route.ts
health/
        route.ts
web-search/
        route.ts
parse-pdf/
        route.ts
transcription/
        route.ts
verify-video-provider/
        route.ts
.github/
    pull_request_template.md
workflows/
      ci.yml
ISSUE_TEMPLATE/
      feature_request.yml
      config.yml
      bug_report.yml
skills/
openmaic/
      SKILL.md
references/
        generate-flow.md
        startup-modes.md
        hosted-mode.md
        clone.md
        provider-keys.md
components/
    server-providers-init.tsx
    header.tsx
    user-profile.tsx
    stage.tsx
ui/
      progress.tsx
      input.tsx
      select.tsx
      dropdown-menu.tsx
      slider.tsx
      button-group.tsx
      tooltip.tsx
      context-menu.tsx
      textarea.tsx
      label.tsx
      switch.tsx
      sonner.tsx
      combobox.tsx
      badge.tsx
      scroll-area.tsx
      tabs.tsx
      separator.tsx
      popover.tsx
      collapsible.tsx
      alert-dialog.tsx
      command.tsx
      dialog.tsx
      alert.tsx
      checkbox.tsx
      button.tsx
      avatar.tsx
      input-group.tsx
      field.tsx
      hover-card.tsx
      card.tsx
      carousel.tsx
roundtable/
      index.tsx
stage/
      scene-renderer.tsx
      scene-sidebar.tsx
settings/
      utils.ts
      model-selector.tsx
      agent-settings.tsx
      general-settings.tsx
      pdf-settings.tsx
      index.tsx
      tts-settings.tsx
      provider-list.tsx
      asr-settings.tsx
      video-settings.tsx
      model-edit-dialog.tsx
      image-settings.tsx
      provider-config-panel.tsx
      audio-settings.tsx
      add-provider-dialog.tsx
      web-search-settings.tsx
chat/
      lecture-notes-view.tsx
      proactive-card.tsx
      use-chat-sessions.ts
      chat-session.tsx
      process-sse-stream.ts
      inline-action-tag.tsx
      session-list.tsx
      chat-area.tsx
canvas/
      canvas-area.tsx
      canvas-toolbar.tsx
slide-renderer/
components/
element/
          ElementOutline.tsx
          ProsemirrorEditor.tsx
ChartElement/
            BaseChartElement.tsx
            index.tsx
            Chart.tsx
            chartOption.ts
ShapeElement/
            BaseShapeElement.tsx
            index.tsx
            PatternDefs.tsx
            GradientDefs.tsx
VideoElement/
            index.tsx
            BaseVideoElement.tsx
LatexElement/
            index.tsx
            BaseLatexElement.tsx
ImageElement/
            BaseImageElement.tsx
            useFilter.ts
            index.tsx
            useClipImage.ts
            ImageClipHandler.tsx
ImageOutline/
              image-rect-outline.tsx
              index.tsx
              image-ellipse-outline.tsx
              image-polygon-outline.tsx
LineElement/
            BaseLineElement.tsx
            index.tsx
            LinePointMarker.tsx
TextElement/
            BaseTextElement.tsx
            index.tsx
TableElement/
            StaticTable.tsx
            index.tsx
            BaseTableElement.tsx
            tableUtils.ts
hooks/
            useElementOutline.ts
            useElementShadow.ts
            useElementFlip.ts
            useElementFill.ts
ThumbnailSlide/
          index.tsx
          ThumbnailElement.tsx
Editor/
        LaserOverlay.tsx
        ScreenElement.tsx
        HighlightOverlay.tsx
        index.tsx
        ZoomWrapper.tsx
        SpotlightOverlay.tsx
        ScreenCanvas.tsx
Canvas/
          GridLines.tsx
          Ruler.tsx
          MouseSelection.tsx
          index.tsx
          ElementCreateSelection.tsx
          ShapeCreateCanvas.tsx
          EditableElement.tsx
          AlignmentLine.tsx
          ViewportBackground.tsx
Operate/
            TableElementOperate.tsx
            ShapeElementOperate.tsx
            index.tsx
            CommonElementOperate.tsx
            RotateHandler.tsx
            LineElementOperate.tsx
            MultiSelectOperate.tsx
            ResizeHandler.tsx
            ImageElementOperate.tsx
            TextElementOperate.tsx
            BorderLine.tsx
hooks/
            useDrop.ts
            useDragLineElement.ts
            useCommonOperate.ts
            useViewportSize.ts
            useMoveShapeKeypoint.ts
            useDragElement.ts
            useSelectElement.ts
            useScaleElement.ts
            useInsertFromCreateSelection.ts
            useMouseSelection.ts
            useRotateElement.ts
scene-renderers/
      interactive-renderer.tsx
      quiz-view.tsx
      quiz-renderer.tsx
      pbl-renderer.tsx
pbl/
        chat-panel.tsx
        guide.tsx
        use-pbl-chat.ts
        workspace.tsx
        issueboard-panel.tsx
        role-selection.tsx
whiteboard/
      index.tsx
      whiteboard-canvas.tsx
generation/
      generating-progress.tsx
      media-popover.tsx
      outlines-editor.tsx
      generation-toolbar.tsx
agent/
      agent-bar.tsx
      agent-avatar.tsx
      agent-reveal-modal.tsx
      agent-config-panel.tsx
audio/
      tts-config-popover.tsx
      speech-button.tsx
ai-elements/
      open-in-chat.tsx
      model-selector.tsx
      web-preview.tsx
      reasoning.tsx
      sources.tsx
      context.tsx
      panel.tsx
      edge.tsx
      suggestion.tsx
      checkpoint.tsx
      chain-of-thought.tsx
      confirmation.tsx
      loader.tsx
      tool.tsx
      image.tsx
      node.tsx
      artifact.tsx
      task.tsx
      code-block.tsx
      plan.tsx
      toolbar.tsx
      connection.tsx
      prompt-input.tsx
      conversation.tsx
      shimmer.tsx
      message.tsx
      canvas.tsx
      queue.tsx
      inline-citation.tsx
      controls.tsx
assets/
    logo-horizontal.png
    openclaw-feishu-demo.gif
    deepseek.gif
    banner.png
    slides.gif
    interactive.gif
    avalon.gif
    quiz.gif
    pbl.gif
    python.gif
    feishu-qrcode.png
    discussion.gif
    zhipu-minimax.gif
.claude/
    settings.local.json
lib/
    logger.ts
playback/
      derived-state.ts
      engine.ts
      index.ts
      types.ts
constants/
      generation.ts
types/
      provider.ts
      slides.ts
      edit.ts
      generation.ts
      roundtable.ts
      action.ts
      pdf.ts
      web-search.ts
      export.ts
      chat.ts
      settings.ts
      stage.ts
buffer/
      stream-buffer.ts
pbl/
      generate-pbl.ts
      pbl-system-prompt.ts
      types.ts
mcp/
        issueboard-mcp.ts
        agent-templates.ts
        mode-mcp.ts
        agent-mcp.ts
        project-mcp.ts
pdf/
      README.md
      constants.ts
      types.ts
      pdf-providers.ts
chat/
      action-translations.ts
action/
      engine.ts
media/
      media-orchestrator.ts
      video-providers.ts
      types.ts
      image-providers.ts
adapters/
        veo-adapter.ts
        kling-adapter.ts
        seedream-adapter.ts
        nano-banana-adapter.ts
        qwen-image-adapter.ts
        seedance-adapter.ts
store/
      canvas.ts
      media-generation.ts
      index.ts
      user-profile.ts
      snapshot.ts
      keyboard.ts
      settings.ts
      stage.ts
utils/
      chat-storage.ts
      playback-storage.ts
      image-storage.ts
      create-selectors.ts
      element.ts
      cn.ts
      geometry.ts
      audio-player.ts
      index.ts
      emitter.ts
      model-config.ts
      stage-storage.ts
      database.ts
i18n/
      generation.ts
      index.ts
      types.ts
      common.ts
      chat.ts
      settings.ts
      stage.ts
generation/
      json-repair.ts
      action-parser.ts
      pipeline-types.ts
      generation-pipeline.ts
      scene-generator.ts
      pipeline-runner.ts
      interactive-post-processor.ts
      prompt-formatters.ts
      outline-generator.ts
      scene-builder.ts
prompts/
        index.ts
        loader.ts
        types.ts
snippets/
          json-output-rules.md
          action-types.md
          element-types.md
templates/
requirements-to-outlines/
            user.md
            system.md
interactive-html/
            user.md
            system.md
pbl-actions/
            user.md
            system.md
quiz-content/
            user.md
            system.md
slide-actions/
            user.md
            system.md
interactive-scientific-model/
            user.md
            system.md
quiz-actions/
            user.md
            system.md
slide-content/
            user.md
            system.md
interactive-actions/
            user.md
            system.md
export/
      svg-path-parser.ts
      latex-to-omml.ts
      svg2base64.ts
      svg-arc-to-cubic-bezier.d.ts
      use-export-pptx.ts
html-parser/
        parser.ts
        lexer.ts
        index.ts
        stringify.ts
        types.ts
        tags.ts
        format.ts
ai/
      providers.ts
      thinking-context.ts
      llm.ts
storage/
      index.ts
      types.ts
providers/
        noop.ts
server/
      provider-config.ts
      classroom-job-store.ts
      ssrf-guard.ts
      classroom-job-runner.ts
      classroom-generation.ts
      proxy-fetch.ts
      resolve-model.ts
      classroom-storage.ts
      api-response.ts
web-search/
      tavily.ts
      constants.ts
      types.ts
hooks/
      use-order-element.ts
      use-theme.tsx
      use-slide-background-style.ts
      use-audio-recorder.ts
      use-history-snapshot.ts
      use-canvas-operations.ts
      use-streaming-text.ts
      use-draft-cache.ts
      use-browser-asr.ts
      use-i18n.tsx
      use-browser-tts.ts
      use-scene-generator.ts
audio/
      tts-providers.ts
      asr-providers.ts
      constants.ts
      types.ts
      azure.json
prosemirror/
      utils.ts
      index.ts
commands/
        setTextIndent.ts
        setTextAlign.ts
        setListStyle.ts
        toggleList.ts
        replaceText.ts
schema/
        marks.ts
        index.ts
        nodes.ts
plugins/
        inputrules.ts
        placeholder.ts
        index.ts
        keymap.ts
contexts/
      media-stage-context.tsx
      scene-context.tsx
orchestration/
      tool-schemas.ts
      director-graph.ts
      prompt-builder.ts
      director-prompt.ts
      stateless-generate.ts
      ai-sdk-adapter.ts
registry/
        store.ts
        types.ts
api/
      stage-api-types.ts
      stage-api-navigation.ts
      stage-api-element.ts
      stage-api-whiteboard.ts
      stage-api-defaults.ts
      stage-api.ts
      stage-api-mode.ts
      stage-api-scene.ts
      stage-api-canvas.ts
public/
    logo-horizontal.png
avatars/
      curious.svg
      clown.svg
      student2.svg
      curious-2.png
      teacher-2.png
      reader.svg
      user.svg
      thinker.svg
      teacher.svg
      note-taker-2.png
      dreamer.svg
      coder.svg
      notes.svg
      user.png
      note-taker.png
      student3.svg
      assist-2.png
      curious.png
      learner.svg
      teacher.png
      clown.png
      creative.svg
      scholar.svg
      clown-2.png
      thinker-2.png
      assist.png
      explorer.svg
      builder.svg
      student1.svg
      thinker.png
      assistant.svg
logos/
      kimi.png
      openai.svg
      doubao.svg
      unpdf.svg
      kling.svg
      mineru.png
      azure.svg
      qwen.svg
      gemini.svg
      bailian.svg
      deepseek.svg
      glm.svg
      minimax.svg
      browser.svg
      siliconflow.svg
      claude.svg
packages/
pptxgenjs/
      tsconfig.json
      package.json
      rollup.config.mjs
      .gitignore
types/
        index.d.ts
src/
        gen-media.ts
        gen-tables.ts
        pptxgen.ts
        core-enums.ts
        gen-objects.ts
        gen-utils.ts
        gen-charts.ts
        gen-xml.ts
        slide.ts
        core-interfaces.ts
mathml2omml/
      package.json
      rollup.config.js
      .gitignore
      LICENSE
src/
        index.d.ts
        helpers.js
        walker.js
        index.js
parse-stringify/
          parse-tag.js
          stringify.js
          parse.js
          index.js
mathml/
          mmultiscripts.js
          msubsup.js
          mroot.js
          munderover.js
          math.js
          mfrac.js
          text_container.js
          index.js
          text_style.js
          msub.js
          text.js
          mstyle.js
          menclose.js
          msup.js
          msqrt.js
          mrow.js
          table.js
          under_or_over.js
          mglyph.js
          mspace.js
ooml/
          scriptlevel.js
          nary.js
          index.js


## API Routes
app/api/generate-classroom/route.ts
app/api/verify-model/route.ts
app/api/classroom/route.ts
app/api/verify-pdf-provider/route.ts
app/api/proxy-media/route.ts
app/api/chat/route.ts
app/api/verify-image-provider/route.ts
app/api/server-providers/route.ts
app/api/azure-voices/route.ts
app/api/quiz-grade/route.ts
app/api/health/route.ts
app/api/web-search/route.ts
app/api/parse-pdf/route.ts
app/api/transcription/route.ts
app/api/verify-video-provider/route.ts
app/api/generate-classroom/[jobId]/route.ts
app/api/pbl/chat/route.ts
app/api/generate/scene-outlines-stream/route.ts
app/api/generate/agent-profiles/route.ts
app/api/generate/tts/route.ts
app/api/generate/scene-content/route.ts
app/api/generate/video/route.ts
app/api/generate/scene-actions/route.ts
app/api/generate/image/route.ts

## Dependencies

next.config.ts
  -> next
configs/animation.ts
  -> @/lib/types/slides
configs/theme.ts
  -> @/lib/types/slides
configs/chart.ts
  -> @/lib/types/slides
configs/shapes.ts
  -> @/lib/types/slides
configs/lines.ts
  -> @/lib/types/slides
app/page.tsx
  -> react
  -> next/navigation
  -> motion/react
  -> @/lib/hooks/use-i18n
  -> @/lib/logger
  -> @/components/ui/button
  -> @/components/ui/textarea
  -> @/lib/utils
  -> @/components/settings
  -> @/components/generation/generation-toolbar
  -> @/components/agent/agent-bar
  -> @/lib/hooks/use-theme
  -> nanoid
  -> @/lib/utils/image-storage
  -> @/lib/types/generation
  -> @/lib/store/settings
  -> @/lib/store/user-profile
  -> @/components/slide-renderer/components/ThumbnailSlide
  -> @/lib/types/slides
  -> @/lib/store/media-generation
  -> sonner
  -> @/components/ui/tooltip
  -> @/lib/hooks/use-draft-cache
  -> @/components/audio/speech-button
app/layout.tsx
  -> next
  -> next/font/local
  -> geist/font/sans
  -> geist/font/mono
  -> @/lib/hooks/use-theme
  -> @/lib/hooks/use-i18n
  -> @/components/ui/sonner
  -> @/components/server-providers-init
components/server-providers-init.tsx
  -> react
  -> @/lib/store/settings
components/header.tsx
  -> @/lib/hooks/use-i18n
  -> @/lib/hooks/use-theme
  -> react
  -> next/navigation
  -> ./settings
  -> @/lib/utils
  -> @/lib/store/settings
  -> @/lib/store/stage
  -> @/lib/store/media-generation
  -> @/lib/export/use-export-pptx
components/user-profile.tsx
  -> react
  -> lucide-react
  -> motion/react
  -> @/components/ui/card
  -> @/components/ui/textarea
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> sonner
  -> @/lib/store/user-profile
components/stage.tsx
  -> react
  -> @/lib/store
  -> @/lib/store/stage
  -> @/lib/store/canvas
  -> @/lib/store/settings
  -> @/lib/hooks/use-i18n
  -> ./stage/scene-sidebar
  -> ./header
  -> @/components/canvas/canvas-area
  -> @/components/roundtable
  -> @/lib/playback
  -> @/lib/playback
  -> @/lib/action/engine
  -> @/lib/utils/audio-player
  -> @/lib/types/action
  -> @/components/chat/chat-area
  -> @/lib/orchestration/registry/store
  -> @/lib/orchestration/registry/types
  -> lucide-react
  -> radix-ui
app/generation-preview/page.tsx
  -> react
  -> next/navigation
  -> motion/react
  -> lucide-react
  -> @/components/ui/button
  -> @/components/ui/card
  -> @/components/ui/tooltip
  -> @/lib/utils
  -> @/lib/store/stage
  -> @/lib/store/settings
  -> @/lib/orchestration/registry/store
  -> @/lib/hooks/use-i18n
  -> @/lib/utils/model-config
  -> @/lib/utils/database
  -> @/lib/constants/generation
  -> nanoid
  -> @/lib/types/stage
  -> @/lib/types/generation
  -> @/components/agent/agent-reveal-modal
  -> @/lib/logger
  -> ./types
  -> ./components/visualizers
app/generation-preview/types.ts
  -> lucide-react
  -> @/lib/store/settings
app/classroom/[id]/page.tsx
  -> @/components/stage
  -> @/lib/hooks/use-theme
  -> @/lib/store
  -> @/lib/utils/image-storage
  -> react
  -> next/navigation
  -> @/lib/hooks/use-scene-generator
  -> @/lib/store/media-generation
  -> @/lib/logger
  -> @/lib/contexts/media-stage-context
  -> @/lib/media/media-orchestrator
app/generation-preview/components/visualizers.tsx
  -> react
  -> motion/react
  -> @/lib/utils
  -> @/lib/types/generation
app/api/generate-classroom/route.ts
  -> next/server
  -> nanoid
  -> @/lib/server/api-response
  -> @/lib/server/classroom-generation
  -> @/lib/server/classroom-job-runner
  -> @/lib/server/classroom-job-store
  -> @/lib/server/classroom-storage
app/api/verify-model/route.ts
  -> next/server
  -> ai
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/resolve-model
app/api/classroom/route.ts
  -> next/server
  -> crypto
  -> @/lib/server/api-response
app/api/verify-pdf-provider/route.ts
  -> next/server
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/provider-config
  -> @/lib/server/ssrf-guard
app/api/proxy-media/route.ts
  -> next/server
  -> @/lib/server/ssrf-guard
  -> @/lib/server/api-response
  -> @/lib/logger
app/api/chat/route.ts
  -> next/server
  -> @/lib/orchestration/stateless-generate
  -> @/lib/ai/providers
  -> @/lib/server/provider-config
  -> @/lib/types/chat
  -> @/lib/types/provider
  -> @/lib/server/api-response
  -> @/lib/logger
  -> @/lib/server/ssrf-guard
app/api/verify-image-provider/route.ts
  -> next/server
  -> @/lib/media/image-providers
  -> @/lib/server/provider-config
  -> @/lib/media/types
  -> @/lib/server/api-response
  -> @/lib/logger
  -> @/lib/server/ssrf-guard
app/api/server-providers/route.ts
  -> @/lib/server/api-response
  -> @/lib/logger
app/api/azure-voices/route.ts
  -> next/server
  -> @/lib/logger
  -> @/lib/server/ssrf-guard
  -> @/lib/server/api-response
app/api/quiz-grade/route.ts
  -> next/server
  -> @/lib/ai/llm
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/resolve-model
app/api/health/route.ts
  -> @/lib/server/api-response
app/api/web-search/route.ts
  -> @/lib/web-search/tavily
  -> @/lib/server/provider-config
  -> @/lib/logger
  -> @/lib/server/api-response
app/api/parse-pdf/route.ts
  -> next/server
  -> @/lib/pdf/pdf-providers
  -> @/lib/server/provider-config
  -> @/lib/pdf/types
  -> @/lib/types/pdf
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/ssrf-guard
app/api/transcription/route.ts
  -> next/server
  -> @/lib/audio/asr-providers
  -> @/lib/server/provider-config
  -> @/lib/audio/types
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/ssrf-guard
app/api/verify-video-provider/route.ts
  -> next/server
  -> @/lib/media/video-providers
  -> @/lib/server/provider-config
  -> @/lib/media/types
  -> @/lib/server/api-response
  -> @/lib/logger
  -> @/lib/server/ssrf-guard
app/api/generate-classroom/[jobId]/route.ts
  -> next/server
  -> @/lib/server/api-response
  -> @/lib/server/classroom-storage
app/api/pbl/chat/route.ts
  -> next/server
  -> @/lib/ai/llm
  -> @/lib/pbl/types
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/resolve-model
app/api/generate/scene-outlines-stream/route.ts
  -> next/server
  -> @/lib/ai/llm
  -> @/lib/generation/prompts
  -> @/lib/generation/generation-pipeline
  -> @/lib/constants/generation
  -> nanoid
  -> @/lib/server/api-response
  -> @/lib/logger
  -> @/lib/server/resolve-model
app/api/generate/agent-profiles/route.ts
  -> next/server
  -> nanoid
  -> @/lib/ai/llm
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/resolve-model
app/api/generate/tts/route.ts
  -> next/server
  -> @/lib/audio/tts-providers
  -> @/lib/server/provider-config
  -> @/lib/audio/types
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/ssrf-guard
app/api/generate/scene-content/route.ts
  -> next/server
  -> @/lib/ai/llm
  -> @/lib/generation/generation-pipeline
  -> @/lib/types/generation
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/resolve-model
app/api/generate/video/route.ts
  -> next/server
  -> @/lib/media/video-providers
  -> @/lib/server/provider-config
  -> @/lib/media/types
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/ssrf-guard
app/api/generate/scene-actions/route.ts
  -> next/server
  -> @/lib/ai/llm
  -> @/lib/types/generation
  -> @/lib/types/action
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/resolve-model
app/api/generate/image/route.ts
  -> next/server
  -> @/lib/media/image-providers
  -> @/lib/server/provider-config
  -> @/lib/media/types
  -> @/lib/logger
  -> @/lib/server/api-response
  -> @/lib/server/ssrf-guard
components/ui/progress.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
components/ui/input.tsx
  -> react
  -> @/lib/utils
components/ui/select.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
  -> lucide-react
components/ui/dropdown-menu.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
  -> lucide-react
components/ui/slider.tsx
  -> react
  -> @radix-ui/react-slider
  -> @/lib/utils
components/ui/button-group.tsx
  -> class-variance-authority
  -> radix-ui
  -> @/lib/utils
  -> @/components/ui/separator
components/ui/tooltip.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
components/ui/context-menu.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
  -> lucide-react
components/ui/textarea.tsx
  -> react
  -> @/lib/utils
components/ui/label.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
components/ui/switch.tsx
  -> react
  -> @radix-ui/react-switch
  -> @/lib/utils
components/ui/sonner.tsx
  -> next-themes
  -> sonner
components/ui/combobox.tsx
  -> react
  -> @base-ui/react
  -> @/lib/utils
  -> @/components/ui/button
  -> lucide-react
components/ui/badge.tsx
  -> react
  -> class-variance-authority
  -> radix-ui
  -> @/lib/utils
components/ui/scroll-area.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
components/ui/tabs.tsx
  -> react
  -> class-variance-authority
  -> radix-ui
  -> @/lib/utils
components/ui/separator.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
components/ui/popover.tsx
  -> react
  -> @radix-ui/react-popover
  -> @/lib/utils
components/ui/collapsible.tsx
  -> radix-ui
components/ui/alert-dialog.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
  -> @/components/ui/button
components/ui/command.tsx
  -> react
  -> cmdk
  -> @/lib/utils
  -> @/components/ui/input-group
  -> lucide-react
components/ui/dialog.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
  -> @/components/ui/button
  -> lucide-react
components/ui/alert.tsx
  -> react
  -> class-variance-authority
  -> @/lib/utils
components/ui/checkbox.tsx
  -> react
  -> @radix-ui/react-checkbox
  -> lucide-react
  -> @/lib/utils
components/ui/button.tsx
  -> react
  -> class-variance-authority
  -> radix-ui
  -> @/lib/utils
components/ui/avatar.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
components/ui/input-group.tsx
  -> react
  -> class-variance-authority
  -> @/lib/utils
  -> @/components/ui/button
  -> @/components/ui/input
  -> @/components/ui/textarea
components/ui/field.tsx
  -> react
  -> class-variance-authority
  -> @/lib/utils
  -> @/components/ui/label
  -> @/components/ui/separator
components/ui/hover-card.tsx
  -> react
  -> radix-ui
  -> @/lib/utils
components/ui/card.tsx
  -> react
  -> @/lib/utils
components/ui/carousel.tsx
  -> react
  -> embla-carousel-react
  -> @/lib/utils
  -> @/components/ui/button
  -> lucide-react
components/roundtable/index.tsx
  -> react
  -> motion/react
  -> @/lib/utils
  -> @/components/canvas/canvas-toolbar
  -> @/lib/hooks/use-audio-recorder
  -> @/lib/hooks/use-i18n
  -> sonner
  -> @/lib/store/settings
  -> @/components/chat/proactive-card
  -> @/components/ui/hover-card
  -> @/lib/orchestration/registry/store
  -> @/lib/types/action
  -> @/lib/playback
  -> @/lib/types/roundtable
components/stage/scene-renderer.tsx
  -> react
  -> @/lib/types/stage
  -> ../slide-renderer/Editor
  -> ../scene-renderers/quiz-view
  -> ../scene-renderers/interactive-renderer
  -> ../scene-renderers/pbl-renderer
components/stage/scene-sidebar.tsx
  -> react
  -> next/navigation
  -> @/lib/utils
  -> @/components/slide-renderer/components/ThumbnailSlide
  -> @/lib/store
  -> @/lib/hooks/use-i18n
  -> @/lib/types/stage
  -> @/lib/store/stage
components/settings/model-selector.tsx
  -> react
  -> @/components/ui/button
  -> @/components/ui/input
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/ai/providers
  -> @/lib/types/settings
  -> ./utils
components/settings/agent-settings.tsx
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/checkbox
  -> lucide-react
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/components/ui/avatar
components/settings/general-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/button
  -> lucide-react
  -> @/lib/hooks/use-i18n
  -> @/lib/utils/database
  -> sonner
  -> @/lib/logger
components/settings/pdf-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/badge
  -> @/components/ui/button
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/pdf/constants
  -> @/lib/pdf/types
  -> lucide-react
  -> @/lib/utils
components/settings/index.tsx
  -> react
  -> @/components/ui/dialog
  -> @/components/ui/button
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> sonner
  -> @/lib/ai/providers
  -> @/lib/ai/providers
  -> @/lib/utils
  -> ./utils
  -> ./provider-list
  -> ./provider-config-panel
  -> ./pdf-settings
  -> @/lib/pdf/constants
  -> @/lib/pdf/types
  -> ./image-settings
  -> @/lib/media/image-providers
  -> @/lib/media/types
  -> ./video-settings
  -> @/lib/media/video-providers
  -> @/lib/media/types
  -> ./tts-settings
  -> @/lib/audio/constants
  -> @/lib/audio/types
  -> ./asr-settings
  -> @/lib/audio/constants
  -> @/lib/audio/types
  -> ./web-search-settings
  -> @/lib/web-search/constants
  -> @/lib/web-search/types
  -> ./general-settings
  -> ./model-edit-dialog
  -> ./add-provider-dialog
  -> @/lib/types/settings
components/settings/tts-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/button
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/audio/constants
  -> @/lib/audio/types
  -> lucide-react
  -> @/lib/utils
  -> @/lib/logger
components/settings/provider-list.tsx
  -> @/components/ui/button
  -> lucide-react
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/ai/providers
components/settings/asr-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/button
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/audio/constants
  -> @/lib/audio/types
  -> lucide-react
  -> @/lib/utils
  -> @/lib/logger
components/settings/video-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/button
  -> @/components/ui/dialog
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/media/video-providers
  -> @/lib/utils
  -> @/lib/media/types
components/settings/model-edit-dialog.tsx
  -> react
  -> @/components/ui/dialog
  -> @/components/ui/button
  -> @/components/ui/input
  -> @/components/ui/label
  -> @/components/ui/checkbox
  -> lucide-react
  -> @/lib/hooks/use-i18n
  -> @/lib/types/settings
  -> @/lib/ai/providers
  -> @/lib/utils
components/settings/image-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/button
  -> @/components/ui/dialog
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/media/image-providers
  -> @/lib/utils
  -> @/lib/media/types
components/settings/provider-config-panel.tsx
  -> react
  -> @/components/ui/button
  -> @/components/ui/input
  -> @/components/ui/label
  -> @/components/ui/checkbox
  -> @/lib/hooks/use-i18n
  -> @/lib/ai/providers
  -> @/lib/types/settings
  -> ./utils
  -> @/lib/utils
components/settings/audio-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/components/ui/slider
  -> @/components/ui/switch
  -> @/components/ui/button
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/audio/types
  -> lucide-react
  -> @/lib/utils
  -> @/lib/audio/azure.json
  -> @/lib/logger
components/settings/add-provider-dialog.tsx
  -> react
  -> @/components/ui/dialog
  -> @/components/ui/button
  -> @/components/ui/input
  -> @/components/ui/label
  -> @/components/ui/checkbox
  -> lucide-react
  -> @/lib/hooks/use-i18n
  -> @/lib/utils
components/settings/web-search-settings.tsx
  -> react
  -> @/components/ui/label
  -> @/components/ui/input
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/web-search/constants
  -> @/lib/web-search/types
  -> lucide-react
components/chat/lecture-notes-view.tsx
  -> react
  -> lucide-react
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/types/chat
components/chat/proactive-card.tsx
  -> react
  -> react-dom
  -> motion/react
  -> lucide-react
  -> @/lib/hooks/use-i18n
  -> @/lib/types/action
components/chat/use-chat-sessions.ts
  -> react
  -> @/components/roundtable
  -> @/lib/types/action
  -> ai
  -> @/lib/store
  -> @/lib/store/canvas
  -> @/lib/store/settings
  -> @/lib/store/user-profile
  -> @/lib/orchestration/registry/store
  -> @/lib/hooks/use-i18n
  -> @/lib/utils/model-config
  -> @/lib/types/roundtable
  -> ./process-sse-stream
  -> @/lib/buffer/stream-buffer
  -> @/lib/buffer/stream-buffer
  -> @/lib/action/engine
  -> sonner
  -> @/lib/logger
components/chat/chat-session.tsx
  -> react
  -> motion/react
  -> @/lib/types/chat
  -> ai
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> lucide-react
  -> ./inline-action-tag
  -> @/lib/store/user-profile
components/chat/process-sse-stream.ts
  -> @/lib/types/chat
  -> @/lib/buffer/stream-buffer
  -> @/lib/logger
components/chat/inline-action-tag.tsx
  -> @/lib/utils
  -> lucide-react
components/chat/session-list.tsx
  -> @/lib/types/chat
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> lucide-react
  -> motion/react
  -> ./chat-session
components/chat/chat-area.tsx
  -> react
  -> @/lib/types/chat
  -> @/lib/types/chat
  -> @/components/roundtable
  -> @/lib/types/action
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/store
  -> lucide-react
  -> @/components/ui/tabs
  -> ./use-chat-sessions
  -> ./session-list
  -> ./lecture-notes-view
components/canvas/canvas-area.tsx
  -> react
  -> motion/react
  -> lucide-react
  -> @/lib/utils
  -> @/components/stage/scene-renderer
  -> @/lib/contexts/scene-context
  -> @/components/whiteboard
  -> @/components/canvas/canvas-toolbar
  -> @/components/canvas/canvas-toolbar
  -> @/lib/types/stage
  -> @/lib/hooks/use-i18n
components/canvas/canvas-toolbar.tsx
  -> react
  -> @/lib/utils
  -> @/lib/store
  -> @/lib/hooks/use-i18n
  -> @/components/ui/tooltip
components/scene-renderers/interactive-renderer.tsx
  -> react
  -> @/lib/types/stage
components/scene-renderers/quiz-view.tsx
  -> react
  -> motion/react
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/utils/model-config
  -> @/lib/logger
  -> @/lib/types/stage
  -> @/lib/hooks/use-draft-cache
  -> @/components/audio/speech-button
components/scene-renderers/quiz-renderer.tsx
  -> react
  -> @/lib/types/stage
  -> @/components/ui/card
  -> @/components/ui/button
  -> @/lib/utils
components/scene-renderers/pbl-renderer.tsx
  -> react
  -> @/lib/types/stage
  -> @/lib/pbl/types
  -> @/lib/store/stage
  -> ./pbl/role-selection
  -> ./pbl/workspace
  -> @/lib/hooks/use-i18n
components/whiteboard/index.tsx
  -> react
  -> motion/react
  -> lucide-react
  -> ./whiteboard-canvas
  -> @/lib/store
  -> @/lib/store/canvas
  -> @/lib/api/stage-api
  -> sonner
  -> @/lib/hooks/use-i18n
components/whiteboard/whiteboard-canvas.tsx
  -> react
  -> motion/react
  -> @/lib/store
  -> @/lib/store/canvas
  -> @/components/slide-renderer/Editor/ScreenElement
  -> @/lib/types/slides
  -> @/lib/hooks/use-i18n
components/generation/generating-progress.tsx
  -> react
  -> @/components/ui/card
  -> lucide-react
  -> @/lib/hooks/use-i18n
components/generation/media-popover.tsx
  -> react
  -> lucide-react
  -> @/components/ui/popover
  -> @/components/ui/slider
  -> @/components/ui/switch
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/media/image-providers
  -> @/lib/media/video-providers
  -> @/lib/audio/constants
  -> @/lib/audio/constants
  -> @/lib/media/types
  -> @/lib/audio/types
  -> @/lib/types/settings
components/generation/outlines-editor.tsx
  -> @/components/ui/button
  -> @/components/ui/input
  -> @/components/ui/textarea
  -> @/components/ui/label
  -> @/components/ui/card
  -> lucide-react
  -> nanoid
  -> @/lib/types/generation
components/generation/generation-toolbar.tsx
  -> react
  -> lucide-react
  -> @/components/ui/popover
  -> @/components/ui/tooltip
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/pdf/constants
  -> @/lib/pdf/types
  -> @/lib/web-search/constants
  -> @/lib/web-search/types
  -> @/lib/ai/providers
  -> @/lib/types/settings
  -> @/components/generation/media-popover
components/agent/agent-bar.tsx
  -> react
  -> motion/react
  -> @/components/ui/checkbox
  -> @/components/ui/input
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/orchestration/registry/store
  -> lucide-react
  -> @/components/ui/tooltip
components/agent/agent-avatar.tsx
  -> @/components/ui/avatar
components/agent/agent-reveal-modal.tsx
  -> react
  -> motion/react
  -> lucide-react
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
components/agent/agent-config-panel.tsx
  -> react
  -> @/lib/orchestration/registry/store
  -> @/components/ui/button
  -> @/components/ui/card
  -> @/components/ui/badge
  -> @/components/ui/scroll-area
  -> @/components/ui/avatar
  -> lucide-react
components/audio/tts-config-popover.tsx
  -> react
  -> lucide-react
  -> @/components/ui/popover
  -> @/components/ui/switch
  -> @/components/ui/tooltip
  -> @/lib/utils
  -> @/lib/hooks/use-i18n
  -> @/lib/store/settings
  -> @/lib/audio/constants
components/audio/speech-button.tsx
  -> react
  -> lucide-react
  -> @/lib/hooks/use-audio-recorder
  -> @/lib/hooks/use-i18n
  -> @/lib/utils
  -> @/components/ui/tooltip
  -> sonner
components/ai-elements/open-in-chat.tsx
  -> @/components/ui/button
  -> @/lib/utils
  -> lucide-react
  -> react
components/ai-elements/model-selector.tsx
  -> @/components/ui/dialog
  -> @/lib/utils
  -> react
components/ai-elements/web-preview.tsx
  -> @/components/ui/button
  -> @/components/ui/collapsible
  -> @/components/ui/input
  -> @/components/ui/tooltip
  -> @/lib/utils
  -> lucide-react
  -> react
  -> react
components/ai-elements/reasoning.tsx
  -> @radix-ui/react-use-controllable-state
  -> @/components/ui/collapsible
  -> @/lib/utils
  -> lucide-react
  -> react
  -> react
  -> streamdown
  -> ./shimmer
components/ai-elements/sources.tsx
  -> @/components/ui/collapsible
  -> @/lib/utils
  -> lucide-react
  -> react
components/ai-elements/context.tsx
  -> @/components/ui/button
  -> @/components/ui/hover-card
  -> @/components/ui/progress
  -> @/lib/utils
  -> ai
  -> react
  -> tokenlens
components/ai-elements/panel.tsx
  -> @/lib/utils
  -> @xyflow/react
  -> react
components/ai-elements/suggestion.tsx
  -> @/components/ui/button
  -> @/components/ui/scroll-area
  -> @/lib/utils
  -> react
components/ai-elements/checkpoint.tsx
  -> @/components/ui/button
  -> @/components/ui/separator
  -> @/components/ui/tooltip
  -> @/lib/utils
  -> lucide-react
  -> react
components/ai-elements/chain-of-thought.tsx
  -> @radix-ui/react-use-controllable-state
  -> @/components/ui/badge
  -> @/components/ui/collapsible
  -> @/lib/utils
  -> lucide-react
  -> react
  -> react
components/ai-elements/confirmation.tsx
  -> @/components/ui/alert
  -> @/components/ui/button
  -> @/lib/utils
  -> ai
  -> react
components/ai-elements/loader.tsx
  -> @/lib/utils
  -> react
components/ai-elements/tool.tsx
  -> @/components/ui/badge
  -> @/components/ui/collapsible
  -> @/lib/utils
  -> ai
  -> react
  -> react
  -> ./code-block
components/ai-elements/image.tsx
  -> @/lib/utils
  -> ai
components/ai-elements/node.tsx
  -> @/lib/utils
  -> @xyflow/react
  -> react
components/ai-elements/artifact.tsx
  -> @/components/ui/button
  -> @/components/ui/tooltip
  -> @/lib/utils
  -> lucide-react
  -> react
components/ai-elements/task.tsx
  -> @/components/ui/collapsible
  -> @/lib/utils
  -> lucide-react
  -> react
components/ai-elements/code-block.tsx
  -> @/components/ui/button
  -> @/lib/utils
  -> lucide-react
  -> shiki
components/ai-elements/plan.tsx
  -> @/components/ui/button
  -> @/components/ui/collapsible
  -> @/lib/utils
  -> lucide-react
  -> react
  -> react
  -> ./shimmer
components/ai-elements/toolbar.tsx
  -> @/lib/utils
  -> @xyflow/react
  -> react
components/ai-elements/connection.tsx
  -> @xyflow/react
components/ai-elements/prompt-input.tsx
  -> @/components/ui/button
  -> @/components/ui/hover-card
  -> @/lib/utils
  -> @/lib/logger
  -> ai
  -> nanoid
components/ai-elements/conversation.tsx
  -> @/components/ui/button
  -> @/lib/utils
  -> lucide-react
  -> react
  -> react
  -> use-stick-to-bottom
components/ai-elements/shimmer.tsx
  -> @/lib/utils
  -> motion/react
  -> react
components/ai-elements/message.tsx
  -> @/components/ui/button
  -> @/components/ui/button-group
  -> @/components/ui/tooltip
  -> @/lib/utils
  -> ai
  -> lucide-react
  -> react
  -> react
  -> streamdown
components/ai-elements/canvas.tsx
  -> @xyflow/react
  -> react
components/ai-elements/queue.tsx
  -> @/components/ui/button
  -> @/components/ui/collapsible
  -> @/components/ui/scroll-area
  -> @/lib/utils
  -> lucide-react
  -> react
components/ai-elements/inline-citation.tsx
  -> @/components/ui/badge
  -> @/components/ui/hover-card
  -> @/lib/utils
  -> lucide-react
components/ai-elements/controls.tsx
  -> @/lib/utils
  -> @xyflow/react
  -> react
components/slide-renderer/Editor/LaserOverlay.tsx
  -> motion/react
  -> @/lib/types/action
components/slide-renderer/Editor/ScreenElement.tsx
  -> @/lib/types/slides
  -> react
  -> ../components/element/ImageElement/BaseImageElement
  -> ../components/element/TextElement/BaseTextElement
  -> ../components/element/ShapeElement/BaseShapeElement
  -> ../components/element/LineElement/BaseLineElement
  -> ../components/element/ChartElement/BaseChartElement
  -> ../components/element/LatexElement/BaseLatexElement
  -> ../components/element/TableElement/BaseTableElement
  -> ../components/element/VideoElement/BaseVideoElement
  -> @/lib/contexts/scene-context
  -> @/lib/types/stage
components/slide-renderer/Editor/HighlightOverlay.tsx
  -> react
  -> @/lib/contexts/scene-context
  -> @/lib/store/canvas
  -> @/lib/types/stage
  -> @/lib/types/slides
components/slide-renderer/Editor/index.tsx
  -> ./Canvas
  -> @/lib/types/stage
  -> ./ScreenCanvas
components/slide-renderer/Editor/ZoomWrapper.tsx
  -> motion/react
  -> react
  -> @/lib/types/action
components/slide-renderer/Editor/SpotlightOverlay.tsx
  -> react
  -> motion/react
  -> @/lib/contexts/scene-context
  -> @/lib/store/canvas
  -> @/lib/types/stage
  -> @/lib/types/slides
components/slide-renderer/Editor/ScreenCanvas.tsx
  -> ./ScreenElement
  -> ./HighlightOverlay
  -> ./SpotlightOverlay
  -> ./LaserOverlay
  -> @/lib/hooks/use-slide-background-style
  -> @/lib/store
  -> @/lib/contexts/scene-context
  -> @/lib/utils/geometry
  -> @/lib/types/stage
  -> @/lib/types/slides
  -> @/lib/types/action
  -> ./Canvas/hooks/useViewportSize
  -> react
  -> motion/react
components/slide-renderer/components/element/ElementOutline.tsx
  -> @/lib/types/slides
  -> ./hooks/useElementOutline
components/slide-renderer/components/element/ProsemirrorEditor.tsx
  -> react
  -> lodash
  -> @/lib/store
  -> prosemirror-view
  -> prosemirror-commands
  -> @/lib/prosemirror
  -> @/lib/prosemirror/commands/setTextAlign
  -> @/lib/prosemirror/commands/setTextIndent
  -> @/lib/prosemirror/commands/toggleList
  -> @/lib/prosemirror/commands/setListStyle
  -> @/lib/prosemirror/commands/replaceText
  -> @/lib/types/edit
  -> @/configs/hotkey
  -> sonner
components/slide-renderer/components/ThumbnailSlide/index.tsx
  -> react
  -> @/lib/types/slides
  -> @/lib/hooks/use-slide-background-style
  -> ./ThumbnailElement
components/slide-renderer/components/ThumbnailSlide/ThumbnailElement.tsx
  -> react
  -> @/lib/types/slides
  -> ../element/ImageElement/BaseImageElement
  -> ../element/TextElement/BaseTextElement
  -> ../element/ShapeElement/BaseShapeElement
  -> ../element/LineElement/BaseLineElement
  -> ../element/ChartElement/BaseChartElement
  -> ../element/LatexElement/BaseLatexElement
  -> ../element/TableElement/BaseTableElement
  -> ../element/VideoElement/BaseVideoElement
components/slide-renderer/components/element/ChartElement/BaseChartElement.tsx
  -> @/lib/types/slides
  -> ../ElementOutline
  -> ./Chart
components/slide-renderer/components/element/ChartElement/index.tsx
  -> @/lib/types/slides
  -> ../ElementOutline
  -> ./Chart
components/slide-renderer/components/element/ChartElement/Chart.tsx
  -> react
  -> tinycolor2
  -> @/lib/types/slides
  -> ./chartOption
  -> echarts/core
  -> echarts/charts
  -> echarts/components
  -> echarts/renderers
components/slide-renderer/components/element/ChartElement/chartOption.ts
  -> echarts/core
  -> @/lib/types/slides
components/slide-renderer/components/element/ShapeElement/BaseShapeElement.tsx
  -> @/lib/types/slides
  -> ../hooks/useElementOutline
  -> ../hooks/useElementShadow
  -> ../hooks/useElementFlip
  -> ../hooks/useElementFill
  -> ./GradientDefs
  -> ./PatternDefs
components/slide-renderer/components/element/ShapeElement/index.tsx
  -> react
  -> @/lib/types/slides
  -> @/lib/store
  -> @/lib/hooks/use-canvas-operations
  -> @/lib/hooks/use-history-snapshot
  -> ../hooks/useElementShadow
  -> ../hooks/useElementFlip
  -> ../hooks/useElementFill
  -> ../hooks/useElementOutline
  -> ./GradientDefs
  -> ./PatternDefs
  -> ../ProsemirrorEditor
components/slide-renderer/components/element/ShapeElement/GradientDefs.tsx
  -> @/lib/types/slides
components/slide-renderer/components/element/VideoElement/index.tsx
  -> @/lib/types/slides
components/slide-renderer/components/element/VideoElement/BaseVideoElement.tsx
  -> react
  -> motion/react
  -> @/lib/types/slides
  -> @/lib/store/canvas
  -> @/lib/store/media-generation
  -> @/lib/store/settings
  -> @/lib/contexts/media-stage-context
  -> @/lib/media/media-orchestrator
  -> lucide-react
  -> @/lib/hooks/use-i18n
  -> @/lib/logger
components/slide-renderer/components/element/LatexElement/index.tsx
  -> react
  -> @/lib/types/slides
components/slide-renderer/components/element/LatexElement/BaseLatexElement.tsx
  -> react
  -> @/lib/types/slides
components/slide-renderer/components/element/ImageElement/BaseImageElement.tsx
  -> @/lib/types/slides
  -> ../hooks/useElementShadow
  -> ../hooks/useElementFlip
  -> ./useClipImage
  -> ./useFilter
  -> ./ImageOutline
  -> @/lib/store/media-generation
  -> @/lib/store/settings
  -> @/lib/contexts/media-stage-context
  -> @/lib/media/media-orchestrator
  -> lucide-react
  -> @/lib/hooks/use-i18n
components/slide-renderer/components/element/ImageElement/useFilter.ts
  -> react
  -> @/lib/types/slides
components/slide-renderer/components/element/ImageElement/index.tsx
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> @/lib/store
  -> @/lib/hooks/use-canvas-operations
  -> @/lib/hooks/use-history-snapshot
  -> ../hooks/useElementShadow
  -> ../hooks/useElementFlip
  -> ./useClipImage
  -> ./useFilter
  -> ./ImageOutline
  -> ./ImageClipHandler
components/slide-renderer/components/element/ImageElement/useClipImage.ts
  -> react
  -> @/lib/types/slides
  -> @/configs/image-clip
components/slide-renderer/components/element/ImageElement/ImageClipHandler.tsx
  -> react
  -> @/lib/store
  -> @/configs/hotkey
  -> @/lib/types/edit
  -> @/lib/types/edit
  -> @/lib/types/slides
components/slide-renderer/components/element/LineElement/BaseLineElement.tsx
  -> react
  -> @/lib/types/slides
  -> @/lib/utils/element
  -> ../hooks/useElementShadow
  -> ./LinePointMarker
components/slide-renderer/components/element/LineElement/index.tsx
  -> react
  -> @/lib/types/slides
  -> @/lib/utils/element
  -> ../hooks/useElementShadow
  -> ./LinePointMarker
components/slide-renderer/components/element/LineElement/LinePointMarker.tsx
  -> @/lib/types/slides
components/slide-renderer/components/element/TextElement/BaseTextElement.tsx
  -> @/lib/types/slides
  -> ../hooks/useElementShadow
  -> ../ElementOutline
components/slide-renderer/components/element/TextElement/index.tsx
  -> react
  -> lodash
  -> @/lib/store
  -> @/lib/hooks/use-history-snapshot
  -> @/lib/types/slides
  -> ../hooks/useElementShadow
  -> ../ElementOutline
  -> ../ProsemirrorEditor
  -> @/lib/hooks/use-canvas-operations
components/slide-renderer/components/element/TableElement/StaticTable.tsx
  -> react
  -> @/lib/types/slides
  -> @/lib/utils/element
  -> ./tableUtils
components/slide-renderer/components/element/TableElement/index.tsx
  -> @/lib/types/slides
  -> ./StaticTable
components/slide-renderer/components/element/TableElement/BaseTableElement.tsx
  -> @/lib/types/slides
  -> ./StaticTable
components/slide-renderer/components/element/TableElement/tableUtils.ts
  -> react
  -> @/lib/types/slides
components/slide-renderer/components/element/hooks/useElementOutline.ts
  -> react
  -> @/lib/types/slides
components/slide-renderer/components/element/hooks/useElementShadow.ts
  -> react
  -> @/lib/types/slides
components/slide-renderer/components/element/hooks/useElementFlip.ts
  -> react
components/slide-renderer/components/element/hooks/useElementFill.ts
  -> react
  -> @/lib/types/slides
components/slide-renderer/components/element/ImageElement/ImageOutline/image-rect-outline.tsx
  -> @/lib/types/slides
  -> ../../hooks/useElementOutline
components/slide-renderer/components/element/ImageElement/ImageOutline/index.tsx
  -> @/lib/types/slides
  -> ../useClipImage
  -> ./image-rect-outline
  -> ./image-ellipse-outline
  -> ./image-polygon-outline
components/slide-renderer/components/element/ImageElement/ImageOutline/image-ellipse-outline.tsx
  -> @/lib/types/slides
  -> ../../hooks/useElementOutline
components/slide-renderer/components/element/ImageElement/ImageOutline/image-polygon-outline.tsx
  -> @/lib/types/slides
  -> ../../hooks/useElementOutline
components/slide-renderer/Editor/Canvas/GridLines.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/stage
  -> @/lib/types/slides
components/slide-renderer/Editor/Canvas/Ruler.tsx
  -> react
  -> @/lib/store
  -> @/lib/utils/element
  -> @/lib/types/slides
  -> ./hooks/useViewportSize
components/slide-renderer/Editor/Canvas/index.tsx
  -> react
  -> @/lib/store/canvas
  -> @/lib/contexts/scene-context
  -> @/lib/store/keyboard
  -> ./hooks/useViewportSize
  -> ./hooks/useSelectElement
  -> ./hooks/useDragElement
  -> ./hooks/useRotateElement
  -> ./hooks/useMouseSelection
  -> ./hooks/useScaleElement
  -> ./hooks/useDragLineElement
  -> ./hooks/useMoveShapeKeypoint
  -> ./hooks/useInsertFromCreateSelection
  -> ./hooks/useDrop
  -> ./AlignmentLine
  -> ./MouseSelection
  -> ./ViewportBackground
  -> ./EditableElement
  -> ./Operate
  -> ./Operate/MultiSelectOperate
  -> ./ElementCreateSelection
  -> ./ShapeCreateCanvas
  -> ./Ruler
  -> ./GridLines
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> ./EditableElement
  -> @/lib/types/stage
  -> @/lib/hooks/use-canvas-operations
components/slide-renderer/Editor/Canvas/ElementCreateSelection.tsx
  -> react
  -> @/lib/store
  -> @/lib/store/keyboard
  -> @/lib/types/edit
components/slide-renderer/Editor/Canvas/ShapeCreateCanvas.tsx
  -> react
  -> @/lib/store/keyboard
  -> @/lib/store
  -> @/lib/types/edit
  -> @/lib/types/stage
  -> @/lib/types/slides
  -> sonner
components/slide-renderer/Editor/Canvas/EditableElement.tsx
  -> react
  -> @/lib/types/slides
  -> ../../components/element/ImageElement
  -> ../../components/element/TextElement
  -> ../../components/element/LineElement
  -> ../../components/element/ShapeElement
  -> ../../components/element/ChartElement
  -> ../../components/element/LatexElement
  -> ../../components/element/TableElement
  -> ../../components/element/VideoElement
  -> @/lib/types/edit
  -> @/lib/hooks/use-canvas-operations
components/slide-renderer/Editor/Canvas/AlignmentLine.tsx
  -> @/lib/types/edit
components/slide-renderer/Editor/Canvas/ViewportBackground.tsx
  -> @/lib/contexts/scene-context
  -> @/lib/hooks/use-slide-background-style
  -> @/lib/types/stage
  -> @/lib/types/slides
components/slide-renderer/Editor/Canvas/Operate/TableElementOperate.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> ../hooks/useCommonOperate
  -> ./RotateHandler
  -> ./ResizeHandler
  -> ./BorderLine
components/slide-renderer/Editor/Canvas/Operate/ShapeElementOperate.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> @/configs/shapes
  -> ../hooks/useCommonOperate
  -> ./RotateHandler
  -> ./ResizeHandler
  -> ./BorderLine
components/slide-renderer/Editor/Canvas/Operate/index.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/edit
  -> ./ImageElementOperate
  -> ./TextElementOperate
  -> ./ShapeElementOperate
  -> ./LineElementOperate
  -> ./TableElementOperate
  -> ./CommonElementOperate
  -> @/lib/types/stage
components/slide-renderer/Editor/Canvas/Operate/CommonElementOperate.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/edit
  -> ../hooks/useCommonOperate
  -> ./RotateHandler
  -> ./ResizeHandler
  -> ./BorderLine
components/slide-renderer/Editor/Canvas/Operate/LineElementOperate.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> ./ResizeHandler
components/slide-renderer/Editor/Canvas/Operate/MultiSelectOperate.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/utils/element
  -> @/lib/types/edit
  -> ../hooks/useCommonOperate
  -> ./ResizeHandler
  -> ./BorderLine
components/slide-renderer/Editor/Canvas/Operate/ResizeHandler.tsx
  -> react
  -> @/lib/types/edit
components/slide-renderer/Editor/Canvas/Operate/ImageElementOperate.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> ../hooks/useCommonOperate
  -> ./RotateHandler
  -> ./ResizeHandler
  -> ./BorderLine
components/slide-renderer/Editor/Canvas/Operate/TextElementOperate.tsx
  -> react
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> ../hooks/useCommonOperate
  -> ./RotateHandler
  -> ./ResizeHandler
  -> ./BorderLine
components/slide-renderer/Editor/Canvas/Operate/BorderLine.tsx
  -> @/lib/types/edit
components/slide-renderer/Editor/Canvas/hooks/useDrop.ts
  -> react
  -> @/lib/store
components/slide-renderer/Editor/Canvas/hooks/useDragLineElement.ts
  -> react
  -> @/lib/store/keyboard
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> @/lib/hooks/use-history-snapshot
  -> @/lib/hooks/use-canvas-operations
components/slide-renderer/Editor/Canvas/hooks/useCommonOperate.ts
  -> react
  -> @/lib/types/edit
components/slide-renderer/Editor/Canvas/hooks/useViewportSize.ts
  -> react
  -> @/lib/store
components/slide-renderer/Editor/Canvas/hooks/useMoveShapeKeypoint.ts
  -> react
  -> @/lib/types/slides
  -> @/lib/hooks/use-history-snapshot
  -> @/configs/shapes
  -> @/lib/hooks/use-canvas-operations
components/slide-renderer/Editor/Canvas/hooks/useDragElement.ts
  -> react
  -> @/lib/store
  -> @/lib/hooks/use-history-snapshot
  -> @/lib/types/slides
  -> @/lib/types/edit
  -> @/lib/utils/element
  -> @/lib/hooks/use-canvas-operations
components/slide-renderer/Editor/Canvas/hooks/useSelectElement.ts
  -> react
  -> lodash
  -> @/lib/store
  -> @/lib/store/keyboard
  -> @/lib/types/slides
components/slide-renderer/Editor/Canvas/hooks/useScaleElement.ts
  -> react
  -> @/lib/store
  -> @/lib/store/keyboard
  -> @/configs/element
  -> @/configs/shapes
  -> @/lib/utils/element
  -> @/lib/hooks/use-history-snapshot
  -> @/lib/hooks/use-canvas-operations
components/slide-renderer/Editor/Canvas/hooks/useInsertFromCreateSelection.ts
  -> react
  -> @/lib/store
  -> @/lib/types/edit
components/slide-renderer/Editor/Canvas/hooks/useMouseSelection.ts
  -> react
  -> @/lib/store/keyboard
  -> @/lib/store
  -> @/lib/types/slides
  -> @/lib/utils/element
components/slide-renderer/Editor/Canvas/hooks/useRotateElement.ts
  -> react
  -> @/lib/hooks/use-history-snapshot
  -> @/lib/hooks/use-canvas-operations
components/scene-renderers/pbl/chat-panel.tsx
  -> react
  -> lucide-react
  -> @/lib/pbl/types
  -> @/lib/hooks/use-i18n
  -> @/components/ai-elements/message
  -> @/lib/hooks/use-draft-cache
  -> @/components/audio/speech-button
components/scene-renderers/pbl/guide.tsx
  -> lucide-react
  -> @/lib/hooks/use-i18n
  -> @/components/ui/hover-card
components/scene-renderers/pbl/use-pbl-chat.ts
  -> react
  -> @/lib/pbl/types
  -> @/lib/utils/model-config
  -> @/lib/hooks/use-i18n
  -> @/lib/logger
components/scene-renderers/pbl/workspace.tsx
  -> react
  -> lucide-react
  -> @/lib/pbl/types
  -> ./issueboard-panel
  -> ./chat-panel
  -> ./use-pbl-chat
  -> ./guide
  -> @/lib/hooks/use-i18n
components/scene-renderers/pbl/issueboard-panel.tsx
  -> @/lib/pbl/types
  -> @/lib/hooks/use-i18n
components/scene-renderers/pbl/role-selection.tsx
  -> @/lib/pbl/types
  -> @/lib/hooks/use-i18n
  -> ./guide
lib/playback/derived-state.ts
  -> ./types
lib/playback/engine.ts
  -> @/lib/types/stage
  -> @/lib/types/action
  -> @/lib/utils/audio-player
  -> @/lib/action/engine
  -> @/lib/store/canvas
  -> @/lib/logger
lib/playback/types.ts
  -> @/lib/utils/playback-storage
lib/types/edit.ts
  -> @/configs/shapes
  -> @/configs/lines
  -> ./slides
lib/types/generation.ts
  -> ./action
  -> @/lib/media/types
  -> ./slides
  -> ./stage
  -> @/lib/pbl/types
lib/types/chat.ts
  -> ai
  -> @/lib/types/stage
  -> @/lib/orchestration/director-prompt
lib/types/settings.ts
  -> @/lib/types/provider
lib/types/stage.ts
  -> @/lib/types/slides
  -> @/lib/types/action
  -> @/lib/pbl/types
lib/buffer/stream-buffer.ts
  -> @/lib/types/chat
lib/pbl/generate-pbl.ts
  -> ai
  -> @/lib/ai/llm
  -> zod
  -> ai
  -> ./types
  -> ./mcp/mode-mcp
  -> ./mcp/project-mcp
  -> ./mcp/agent-mcp
  -> ./mcp/issueboard-mcp
  -> ./pbl-system-prompt
  -> ./types
lib/pdf/constants.ts
  -> ./types
lib/pdf/pdf-providers.ts
  -> unpdf
  -> sharp
  -> ./types
  -> @/lib/types/pdf
  -> ./constants
  -> @/lib/logger
lib/chat/action-translations.ts
  -> @/components/ui/badge
  -> lucide-react
  -> react
  -> react
lib/action/engine.ts
  -> @/lib/api/stage-api
  -> @/lib/api/stage-api
  -> @/lib/store/canvas
  -> @/lib/store/media-generation
  -> @/lib/utils/audio-player
  -> katex
  -> @/lib/logger
lib/media/media-orchestrator.ts
  -> @/lib/store/media-generation
  -> @/lib/store/settings
  -> @/lib/utils/database
  -> @/lib/types/generation
  -> @/lib/media/types
  -> @/lib/logger
lib/media/video-providers.ts
  -> ./adapters/seedance-adapter
  -> ./adapters/kling-adapter
  -> ./adapters/veo-adapter
lib/media/image-providers.ts
  -> ./adapters/seedream-adapter
  -> ./adapters/qwen-image-adapter
  -> ./adapters/nano-banana-adapter
lib/store/canvas.ts
  -> zustand
  -> @/lib/utils/create-selectors
  -> @/lib/prosemirror/utils
  -> @/lib/prosemirror/utils
  -> @/lib/types/edit
  -> @/lib/types/action
lib/store/media-generation.ts
  -> zustand
  -> @/lib/media/types
  -> @/lib/utils/database
  -> @/lib/logger
lib/store/index.ts
  -> ./canvas
  -> ./snapshot
  -> ./keyboard
  -> ./stage
  -> ./settings
lib/store/user-profile.ts
  -> zustand
  -> zustand/middleware
lib/store/snapshot.ts
  -> zustand
  -> dexie
  -> @/lib/utils/database
  -> ./stage
  -> @/lib/types/stage
lib/store/keyboard.ts
  -> zustand
lib/store/settings.ts
  -> zustand
  -> zustand/middleware
  -> @/lib/ai/providers
  -> @/lib/types/settings
  -> @/lib/ai/providers
  -> @/lib/audio/types
  -> @/lib/audio/constants
  -> @/lib/pdf/types
  -> @/lib/media/types
  -> @/lib/media/image-providers
  -> @/lib/media/video-providers
  -> @/lib/web-search/types
  -> @/lib/logger
lib/store/stage.ts
  -> zustand
  -> @/lib/types/stage
  -> @/lib/utils/create-selectors
  -> @/lib/types/chat
  -> @/lib/types/generation
  -> @/lib/logger
lib/utils/chat-storage.ts
  -> @/lib/types/chat
  -> ai
  -> ./database
lib/utils/playback-storage.ts
  -> ./database
lib/utils/image-storage.ts
  -> ./database
  -> nanoid
  -> @/lib/logger
lib/utils/create-selectors.ts
  -> zustand
lib/utils/element.ts
  -> tinycolor2
  -> nanoid
  -> @/lib/types/slides
lib/utils/cn.ts
  -> clsx
  -> tailwind-merge
lib/utils/geometry.ts
  -> @/lib/types/slides
  -> @/lib/types/action
lib/utils/audio-player.ts
  -> @/lib/utils/database
  -> @/lib/logger
lib/utils/emitter.ts
  -> mitt
lib/utils/model-config.ts
  -> @/lib/store/settings
lib/utils/stage-storage.ts
  -> ../types/stage
  -> ../types/chat
  -> ./database
  -> ./chat-storage
  -> ./playback-storage
  -> @/lib/logger
lib/utils/database.ts
  -> dexie
  -> @/lib/types/stage
  -> @/lib/types/action
  -> @/lib/types/generation
  -> ai
  -> @/lib/logger
lib/i18n/index.ts
  -> ./types
  -> ./common
  -> ./stage
  -> ./chat
  -> ./generation
  -> ./settings
lib/generation/json-repair.ts
  -> jsonrepair
  -> @/lib/logger
lib/generation/action-parser.ts
  -> @/lib/types/action
  -> @/lib/types/action
  -> nanoid
  -> partial-json
  -> jsonrepair
  -> @/lib/logger
lib/generation/pipeline-types.ts
  -> @/lib/types/generation
lib/generation/scene-generator.ts
  -> nanoid
  -> katex
  -> @/lib/constants/generation
  -> ai
  -> @/lib/api/stage-api
  -> @/lib/api/stage-api
  -> @/lib/pbl/generate-pbl
  -> ./prompts
  -> ./interactive-post-processor
  -> ./action-parser
  -> ./json-repair
  -> @/lib/types/slides
  -> @/lib/types/stage
  -> @/lib/types/action
  -> @/lib/logger
lib/generation/pipeline-runner.ts
  -> nanoid
  -> @/lib/types/generation
  -> @/lib/api/stage-api
  -> ./outline-generator
  -> ./scene-generator
  -> ./pipeline-types
lib/generation/prompt-formatters.ts
  -> @/lib/types/generation
  -> ./pipeline-types
lib/generation/outline-generator.ts
  -> nanoid
  -> @/lib/constants/generation
  -> ./prompts
  -> ./prompt-formatters
  -> ./json-repair
  -> ./scene-builder
  -> ./pipeline-types
  -> @/lib/logger
lib/generation/scene-builder.ts
  -> nanoid
  -> ai
  -> @/lib/types/slides
  -> @/lib/types/stage
  -> @/lib/types/action
  -> ./outline-generator
  -> ./scene-generator
  -> ./pipeline-types
  -> @/lib/logger
lib/export/svg-path-parser.ts
  -> svg-pathdata
  -> svg-arc-to-cubic-bezier
lib/export/latex-to-omml.ts
  -> temml
  -> mathml2omml
  -> @/lib/logger
lib/export/use-export-pptx.ts
  -> react
  -> pptxgenjs
  -> tinycolor2
  -> file-saver
  -> sonner
  -> @/lib/store
  -> @/lib/store/canvas
  -> @/lib/store/media-generation
  -> @/lib/hooks/use-i18n
  -> @/lib/types/stage
  -> @/lib/types/action
  -> @/lib/utils/element
  -> @/lib/export/html-parser
  -> @/lib/export/svg-path-parser
  -> @/lib/export/svg2base64
  -> @/lib/export/latex-to-omml
  -> @/lib/logger
lib/ai/providers.ts
  -> @ai-sdk/openai
  -> @ai-sdk/anthropic
  -> @ai-sdk/google
  -> ai
  -> @/lib/logger
  -> undici
lib/ai/thinking-context.ts
  -> node:async_hooks
  -> @/lib/types/provider
lib/ai/llm.ts
  -> ai
  -> ai
  -> @/lib/logger
  -> ./providers
  -> ./thinking-context
  -> @/lib/types/provider
lib/storage/index.ts
  -> ./providers/noop
  -> ./types
lib/server/provider-config.ts
  -> fs
  -> path
  -> js-yaml
  -> @/lib/logger
lib/server/classroom-job-store.ts
  -> fs
  -> path
lib/server/classroom-job-runner.ts
  -> @/lib/logger
  -> @/lib/server/classroom-generation
lib/server/classroom-generation.ts
  -> nanoid
  -> @/lib/ai/llm
  -> @/lib/api/stage-api
  -> @/lib/api/stage-api-types
  -> @/lib/generation/pipeline-types
  -> @/lib/logger
  -> @/lib/ai/providers
  -> @/lib/server/provider-config
  -> @/lib/server/resolve-model
  -> @/lib/server/classroom-storage
  -> @/lib/types/generation
  -> @/lib/types/stage
lib/server/proxy-fetch.ts
  -> @/lib/server/proxy-fetch
  -> undici
  -> @/lib/logger
lib/server/resolve-model.ts
  -> next/server
  -> @/lib/ai/providers
  -> @/lib/server/provider-config
  -> @/lib/server/ssrf-guard
lib/server/classroom-storage.ts
  -> fs
  -> path
  -> next/server
  -> @/lib/types/stage
lib/server/api-response.ts
  -> next/server
lib/web-search/tavily.ts
  -> @/lib/server/proxy-fetch
  -> @/lib/types/web-search
lib/web-search/constants.ts
  -> ./types
lib/hooks/use-order-element.ts
  -> @/lib/types/slides
lib/hooks/use-theme.tsx
  -> react
lib/hooks/use-slide-background-style.ts
  -> react
  -> @/lib/types/slides
lib/hooks/use-audio-recorder.ts
  -> react
  -> @/lib/logger
lib/hooks/use-history-snapshot.ts
  -> react
  -> @/lib/store/snapshot
lib/hooks/use-canvas-operations.ts
  -> @/lib/contexts/scene-context
  -> @/lib/types/stage
  -> @/lib/types/slides
  -> react
  -> @/lib/hooks/use-history-snapshot
  -> sonner
  -> @/lib/types/edit
  -> @/lib/utils/element
  -> ./use-order-element
  -> nanoid
lib/hooks/use-streaming-text.ts
  -> react
lib/hooks/use-draft-cache.ts
  -> react
lib/hooks/use-browser-asr.ts
  -> react
  -> @/lib/logger
lib/hooks/use-i18n.tsx
  -> react
  -> @/lib/i18n
lib/hooks/use-browser-tts.ts
  -> react
lib/hooks/use-scene-generator.ts
  -> react
  -> @/lib/store/stage
  -> @/lib/utils/model-config
  -> @/lib/store/settings
  -> @/lib/utils/database
  -> @/lib/types/generation
  -> @/lib/generation/generation-pipeline
  -> @/lib/types/stage
  -> @/lib/types/action
  -> @/lib/audio/types
  -> @/lib/media/media-orchestrator
  -> @/lib/logger
lib/audio/tts-providers.ts
  -> ./types
  -> ./constants
lib/audio/asr-providers.ts
  -> @ai-sdk/openai
  -> ai
  -> ./types
  -> ./constants
lib/prosemirror/utils.ts
  -> prosemirror-model
  -> prosemirror-state
  -> prosemirror-view
  -> prosemirror-commands
lib/prosemirror/index.ts
  -> prosemirror-state
  -> prosemirror-view
  -> prosemirror-model
  -> ./plugins/index
  -> ./schema/index
lib/contexts/media-stage-context.tsx
  -> react
lib/contexts/scene-context.tsx
  -> @/lib/store/stage
  -> @/lib/types/stage
  -> immer
lib/orchestration/tool-schemas.ts
  -> @/lib/types/action
lib/orchestration/director-graph.ts
  -> @langchain/langgraph
  -> @langchain/core/messages
  -> @langchain/langgraph
  -> ai
  -> ./ai-sdk-adapter
  -> @/lib/types/chat
  -> @/lib/types/chat
  -> @/lib/types/provider
  -> @/lib/orchestration/registry/types
  -> @/lib/orchestration/registry/store
  -> ./director-prompt
  -> ./tool-schemas
  -> ./director-prompt
  -> ./stateless-generate
  -> @/lib/logger
lib/orchestration/prompt-builder.ts
  -> @/lib/types/chat
  -> @/lib/orchestration/registry/types
  -> ./director-prompt
  -> ./tool-schemas
lib/orchestration/director-prompt.ts
  -> @/lib/orchestration/registry/types
  -> @/lib/logger
lib/orchestration/stateless-generate.ts
  -> ai
  -> @/lib/types/chat
  -> @/lib/types/provider
  -> ./director-prompt
  -> ./director-graph
  -> partial-json
  -> jsonrepair
  -> @/lib/logger
lib/orchestration/ai-sdk-adapter.ts
  -> @langchain/core/language_models/chat_models
  -> @langchain/core/messages
  -> @langchain/core/callbacks/manager
  -> @langchain/core/outputs
  -> ai
  -> @/lib/ai/llm
  -> @/lib/types/provider
  -> @/lib/logger
lib/api/stage-api-types.ts
  -> @/lib/types/stage
  -> @/lib/types/slides
  -> @/lib/types/action
lib/api/stage-api-navigation.ts
  -> @/lib/types/stage
  -> ./stage-api-types
  -> ./stage-api-defaults
lib/api/stage-api-element.ts
  -> @/lib/types/stage
  -> @/lib/types/slides
  -> ./stage-api-types
  -> ./stage-api-defaults
lib/api/stage-api-whiteboard.ts
  -> @/lib/types/stage
  -> @/lib/types/slides
  -> ./stage-api-types
  -> ./stage-api-defaults
lib/api/stage-api-defaults.ts
  -> nanoid
lib/api/stage-api.ts
  -> ./stage-api-scene
  -> ./stage-api-element
  -> ./stage-api-canvas
  -> ./stage-api-navigation
  -> ./stage-api-whiteboard
  -> ./stage-api-mode
  -> ./stage-api-types
lib/api/stage-api-mode.ts
  -> @/lib/types/stage
  -> ./stage-api-types
lib/api/stage-api-scene.ts
  -> @/lib/types/stage
  -> ./stage-api-types
  -> ./stage-api-defaults
lib/api/stage-api-canvas.ts
  -> @/lib/types/stage
  -> @/lib/types/slides
  -> @/lib/store/canvas
  -> ./stage-api-types
  -> ./stage-api-defaults
lib/pbl/mcp/issueboard-mcp.ts
  -> ../types
  -> ./agent-mcp
  -> ./agent-templates
lib/pbl/mcp/mode-mcp.ts
  -> ../types
lib/pbl/mcp/agent-mcp.ts
  -> ../types
lib/pbl/mcp/project-mcp.ts
  -> ../types
lib/media/adapters/kling-adapter.ts
  -> crypto
lib/generation/prompts/loader.ts
  -> fs
  -> path
  -> ./types
  -> @/lib/logger
lib/export/html-parser/parser.ts
  -> ./tags
lib/export/html-parser/lexer.ts
  -> ./types
  -> ./tags
lib/export/html-parser/index.ts
  -> ./lexer
  -> ./parser
  -> ./format
  -> ./stringify
lib/export/html-parser/stringify.ts
  -> ./types
  -> ./tags
lib/export/html-parser/format.ts
  -> ./types
lib/storage/providers/noop.ts
  -> ../types
lib/prosemirror/commands/setTextIndent.ts
  -> prosemirror-model
  -> prosemirror-state
  -> prosemirror-view
  -> ../utils
lib/prosemirror/commands/setTextAlign.ts
  -> prosemirror-model
  -> prosemirror-state
  -> prosemirror-view
lib/prosemirror/commands/setListStyle.ts
  -> prosemirror-view
  -> ../utils
lib/prosemirror/commands/toggleList.ts
  -> prosemirror-schema-list
  -> prosemirror-model
  -> prosemirror-state
  -> ../utils
lib/prosemirror/commands/replaceText.ts
  -> prosemirror-view
  -> prosemirror-model
lib/prosemirror/schema/marks.ts
  -> prosemirror-schema-basic
  -> prosemirror-model
lib/prosemirror/schema/index.ts
  -> ./nodes
  -> ./marks
lib/prosemirror/schema/nodes.ts
  -> prosemirror-schema-basic
  -> prosemirror-model
  -> prosemirror-schema-list
lib/prosemirror/plugins/inputrules.ts
  -> prosemirror-model
lib/prosemirror/plugins/placeholder.ts
  -> prosemirror-state
  -> prosemirror-view
  -> prosemirror-model
lib/prosemirror/plugins/index.ts
  -> prosemirror-keymap
  -> prosemirror-model
  -> prosemirror-history
  -> prosemirror-commands
  -> prosemirror-dropcursor
  -> prosemirror-gapcursor
  -> ./keymap
  -> ./inputrules
  -> ./placeholder
lib/prosemirror/plugins/keymap.ts
  -> prosemirror-schema-list
  -> prosemirror-model
  -> prosemirror-history
  -> prosemirror-inputrules
  -> prosemirror-state
lib/orchestration/registry/store.ts
  -> zustand
  -> zustand/middleware
  -> ./types
  -> ./types
  -> @/lib/types/roundtable
  -> @/lib/types/roundtable
  -> @/lib/store/user-profile
packages/mathml2omml/rollup.config.js
  -> @rollup/plugin-node-resolve
packages/pptxgenjs/types/index.d.ts
  -> ./core-enums
packages/pptxgenjs/src/gen-media.ts
  -> ./core-enums
  -> ./core-interfaces
  -> sizeof
packages/pptxgenjs/src/gen-tables.ts
  -> ./core-enums
  -> ./core-interfaces
  -> ./gen-utils
  -> ./pptxgen
packages/pptxgenjs/src/pptxgen.ts
  -> jszip
  -> ./slide
  -> ./gen-charts
  -> ./gen-objects
  -> ./gen-media
  -> ./gen-tables
  -> ./gen-xml
packages/pptxgenjs/src/core-enums.ts
  -> ./core-interfaces
packages/pptxgenjs/src/gen-objects.ts
  -> ./gen-tables
  -> ./gen-utils
packages/pptxgenjs/src/gen-utils.ts
  -> ./core-enums
  -> ./core-interfaces
packages/pptxgenjs/src/gen-charts.ts
  -> ./core-interfaces
  -> ./gen-utils
  -> jszip
packages/pptxgenjs/src/slide.ts
  -> ./core-enums
  -> ./gen-objects
packages/pptxgenjs/src/core-interfaces.ts
  -> ./core-enums
packages/mathml2omml/src/walker.js
  -> ./mathml/index.js
  -> ./ooml/index.js
packages/mathml2omml/src/index.js
  -> ./parse-stringify
  -> ./walker.js
packages/mathml2omml/src/parse-stringify/parse.js
  -> entities
  -> ./parse-tag
packages/mathml2omml/src/mathml/mmultiscripts.js
  -> ../walker.js
packages/mathml2omml/src/mathml/msubsup.js
  -> ../ooml/index.js
  -> ../walker.js
packages/mathml2omml/src/mathml/mroot.js
  -> ../helpers.js
  -> ../walker.js
packages/mathml2omml/src/mathml/munderover.js
  -> ../ooml/index.js
  -> ../walker.js
packages/mathml2omml/src/mathml/mfrac.js
  -> ../walker.js
packages/mathml2omml/src/mathml/text_container.js
  -> ./text_style.js
packages/mathml2omml/src/mathml/text_style.js
  -> ../helpers.js
packages/mathml2omml/src/mathml/msub.js
  -> ../ooml/index.js
  -> ../walker.js
packages/mathml2omml/src/mathml/msup.js
  -> ../ooml/index.js
  -> ../walker.js
packages/mathml2omml/src/mathml/under_or_over.js
  -> ../ooml/index.js
  -> ../walker.js
  -> ../helpers.js
packages/mathml2omml/src/ooml/nary.js
  -> ../helpers.js



## File Summaries
### next.config.ts
```
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  transpilePackages: ['mathml2omml', 'pptxgenjs'],
  serverExternalPackages: [],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
};

export default nextConfig;
```

### ai_repo_brain.py
```
#!/usr/bin/env python3

import os
import re
from pathlib import Path

ROOT = Path(".")
AI_DIR = ROOT / ".ai_repo"

IGNORE_DIRS = {
    ".git","node_modules",".next","dist","build",".turbo",".cache",
    "__pycache__", ".venv","venv",".ai_repo"
}

CODE_EXT = {".ts",".tsx",".js",".py",".go",".rs",".java"}

API_PATTERNS = [
    r"app\.(get|post|put|delete)\(",
    r"router\.(get|post|put|delete)\(",
    r"@app\.(get|post|put|delete)",
    r"export async function (GET|POST|PUT|DELETE)"
]

IMPORT_PATTERNS = [
    r"import .* from ['\"](.*)['\"]",
    r"require\(['\"](.*)['\"]\)"
]


def ignore(p):
    return any(part in IGNORE_DIRS for part in p.parts)


def get_code_files():
    files = []
    for p in ROOT.rglob("*"):
        if p.is_file() and p.suffix in CODE_EXT and not ignore(p):
            files.append(p)
    return files


def repo_map():
    lines = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in IGNORE_DIRS]

        level = dp.replace(str(ROOT), "").count(os.sep)
        indent = "  " * level

        lines.append(f"{os.path.basename(dp)}/")

        for f in fn:
            lines.append(f"{indent}  {f}")

    return "\n".join(lines)


def detect_frameworks():

    fw = []
```

### configs/latex.ts
```
export const FORMULA_LIST = [
  {
    label: '高斯公式',
    latex: `\\int\\int\\int _ { \\Omega } \\left( \\frac { \\partial {P} } { \\partial {x} } + \\frac { \\partial {Q} } { \\partial {y} } + \\frac { \\partial {R} }{ \\partial {z} } \\right) \\mathrm { d } V = \\oint _ { \\partial \\Omega } ( P \\cos \\alpha + Q \\cos \\beta + R \\cos \\gamma ) \\mathrm{ d} S`,
  },
  {
    label: '傅里叶级数',
    latex: `f(x) = \\frac {a_0} 2 + \\sum_{n = 1}^\\infty {({a_n}\\cos {nx} + {b_n}\\sin {nx})}`,
  },
  {
    label: '泰勒展开式',
    latex: `e ^ { x } = 1 + \\frac { x } { 1 ! } + \\frac { x ^ { 2 } } { 2 ! } + \\frac { x ^ { 3 } } { 3 ! } + ... , \\quad - \\infty < x < \\infty`,
  },
  {
    label: '定积分',
    latex: `\\lim_ { n \\rightarrow + \\infty } \\sum _ { i = 1 } ^ { n } f \\left[ a + \\frac { i } { n } ( b - a ) \\right] \\frac { b - a } { n } = \\int _ { a } ^ { b } f ( x ) dx`,
  },
  {
    label: '三角恒等式1',
    latex: `\\sin \\alpha \\pm \\sin \\beta = 2 \\sin \\frac { 1 } { 2 } ( \\alpha \\pm \\beta ) \\cos \\frac { 1 } { 2 } ( \\alpha \\mp \\beta )`,
  },
  {
    label: '三角恒等式2',
    latex: `\\cos \\alpha + \\cos \\beta = 2 \\cos \\frac { 1 } { 2 } ( \\alpha + \\beta ) \\cos \\frac { 1 } { 2 } ( \\alpha - \\beta )`,
  },
  {
    label: '和的展开式',
    latex: `( 1 + x ) ^ { n } = 1 + \\frac { n x } { 1 ! } + \\frac { n ( n - 1 ) x ^ { 2 } } { 2 ! } + ...`,
  },
  {
    label: '欧拉公式',
    latex: ` e^{ix} = \\cos {x} + i\\sin {x}`,
  },
  {
    label: '贝努利方程',
    latex: `\\frac {dy} {dx} + P(x)y = Q(x) y^n ({n} \\not= {0,1})`,
  },
  {
    label: '全微分方程',
    latex: `du(x,y) = P(x,y)dx + Q(x,y)dy = 0`,
  },
  {
    label: '非齐次方程',
    latex: `y = (\\int Q(x) e^{\\int {P(x)dx}}dx + C)e^{-\\int {P(x)dx}}`,
  },
  {
    label: '柯西中值定理',
    latex: `\\frac{{f(b) - f(a)}}{{F(b) - F(a)}} = \\frac{{f'(\\xi )}}{{F'(\\xi )}}`,
  },
  {
    label: '拉格朗日中值定理',
    latex: `f(b) - f(a) = f'(\\xi )(b - a)`,
  },
  {
    label: '导数公式',
    latex: `(\\arcsin x)' = \\frac{1}{{\\sqrt {1 - x^2} }}`,
  },
  {
    label: '三角函数积分',
    latex: `\\int {tgxdx = - \\ln \\left| {\\cos x} \\right| + C}`,
```

### configs/element.ts
```
export const ELEMENT_TYPE_ZH: Record<string, string> = {
  text: '文本',
  image: '图片',
  shape: '形状',
  line: '线条',
  chart: '图表',
  table: '表格',
  video: '视频',
  audio: '音频',
  latex: '公式',
};

export const MIN_SIZE: Record<string, number> = {
  text: 40,
  image: 20,
  shape: 20,
  chart: 200,
  table: 30,
  video: 250,
  audio: 20,
  latex: 20,
};
```

### configs/animation.ts
```
import type { TurningMode } from '@/lib/types/slides';

export const ANIMATION_DEFAULT_DURATION = 1000;
export const ANIMATION_DEFAULT_TRIGGER = 'click';
export const ANIMATION_CLASS_PREFIX = 'animate__';

export const ENTER_ANIMATIONS = [
  {
    type: 'bounce',
    name: '弹跳',
    children: [
      { name: '弹入', value: 'bounceIn' },
      { name: '向右弹入', value: 'bounceInLeft' },
      { name: '向左弹入', value: 'bounceInRight' },
      { name: '向上弹入', value: 'bounceInUp' },
      { name: '向下弹入', value: 'bounceInDown' },
    ],
  },
  {
    type: 'fade',
    name: '浮现',
    children: [
      { name: '浮入', value: 'fadeIn' },
      { name: '向下浮入', value: 'fadeInDown' },
      { name: '向下长距浮入', value: 'fadeInDownBig' },
      { name: '向右浮入', value: 'fadeInLeft' },
      { name: '向右长距浮入', value: 'fadeInLeftBig' },
      { name: '向左浮入', value: 'fadeInRight' },
      { name: '向左长距浮入', value: 'fadeInRightBig' },
      { name: '向上浮入', value: 'fadeInUp' },
      { name: '向上长距浮入', value: 'fadeInUpBig' },
      { name: '从左上浮入', value: 'fadeInTopLeft' },
      { name: '从右上浮入', value: 'fadeInTopRight' },
      { name: '从左下浮入', value: 'fadeInBottomLeft' },
      { name: '从右下浮入', value: 'fadeInBottomRight' },
    ],
  },
  {
    type: 'rotate',
    name: '旋转',
    children: [
      { name: '旋转进入', value: 'rotateIn' },
      { name: '绕左下进入', value: 'rotateInDownLeft' },
      { name: '绕右下进入', value: 'rotateInDownRight' },
      { name: '绕左上进入', value: 'rotateInUpLeft' },
      { name: '绕右上进入', value: 'rotateInUpRight' },
    ],
  },
  {
    type: 'zoom',
    name: '缩放',
    children: [
      { name: '放大进入', value: 'zoomIn' },
      { name: '向下放大进入', value: 'zoomInDown' },
      { name: '从左放大进入', value: 'zoomInLeft' },
      { name: '从右放大进入', value: 'zoomInRight' },
      { name: '向上放大进入', value: 'zoomInUp' },
    ],
  },
  {
```

### configs/theme.ts
```
import type { PPTElementOutline, PPTElementShadow } from '@/lib/types/slides';

export interface PresetTheme {
  background: string;
  fontColor: string;
  fontname: string;
  colors: string[];
  borderColor?: string;
  outline?: PPTElementOutline;
  shadow?: PPTElementShadow;
}

export const PRESET_THEMES: PresetTheme[] = [
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#41719c',
    fontname: '',
    colors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#5f6f1c',
    fontname: '',
    colors: ['#83992a', '#3c9670', '#44709d', '#a23b32', '#d87728', '#deb340'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#a75f0a',
    fontname: '',
    colors: ['#e48312', '#bd582c', '#865640', '#9b8357', '#c2bc80', '#94a088'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#7c91a8',
    fontname: '',
    colors: ['#bdc8df', '#003fa9', '#f5ba00', '#ff7567', '#7676d9', '#923ffc'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#688e19',
    fontname: '',
    colors: ['#90c225', '#54a121', '#e6b91e', '#e86618', '#c42f19', '#918756'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#4495b0',
    fontname: '',
    colors: ['#1cade4', '#2683c6', '#27ced7', '#42ba97', '#3e8853', '#62a39f'],
  },
  {
    background: '#e9efd6',
    fontColor: '#333333',
    borderColor: '#782009',
    fontname: '',
```

### configs/font.ts
```
export const FONTS = [
  { label: '默认字体', value: '' },
  { label: '思源黑体', value: 'SourceHanSans' },
  { label: '思源宋体', value: 'SourceHanSerif' },
  { label: '文鼎PL楷体', value: 'WenDingPLKaiTi' },
  { label: '文鼎PL宋体', value: 'WenDingPLSongTi' },
  { label: '朱雀仿宋', value: 'ZhuqueFangSong' },
  { label: '霞鹜文楷', value: 'LXGWWenKai' },
  { label: '阿里巴巴普惠体', value: 'AlibabaPuHuiTi' },
  { label: 'MiSans', value: 'MiSans' },
  { label: '得意黑', value: 'DeYiHei' },
  { label: '仓耳小丸子', value: 'CangerXiaowanzi' },
  { label: '优设标题黑', value: 'YousheTitleBlack' },
  { label: '峰广明锐体', value: 'FengguangMingrui' },
  { label: '摄图摩登小方体', value: 'ShetuModernSquare' },
  { label: '站酷快乐体', value: 'ZcoolHappy' },
  { label: '字制区喜脉体', value: 'ZizhiQuXiMai' },
  { label: '素材集市康康体', value: 'SucaiJishiKangkang' },
  { label: '素材集市酷方体', value: 'SucaiJishiCoolSquare' },
  { label: '途牛类圆体', value: 'TuniuRounded' },
  { label: '锐字真言体', value: 'RuiziZhenyan' },
  { label: 'Source Serif 4', value: 'SourceSerif4' },
  { label: 'JetBrains Mono', value: 'JetBrainsMono' },
  { label: 'Literata', value: 'Literata' },
  { label: 'Inter', value: 'Inter' },
  { label: 'Roboto', value: 'Roboto' },
  { label: 'Open Sans', value: 'OpenSans' },
  { label: 'Montserrat', value: 'Montserrat' },
  { label: 'Source Sans Pro', value: 'SourceSansPro' },
  { label: 'Merriweather', value: 'Merriweather' },
];
```

### configs/image-clip.ts
```
export const enum ClipPathTypes {
  RECT = 'rect',
  ELLIPSE = 'ellipse',
  POLYGON = 'polygon',
}

export const enum ClipPaths {
  RECT = 'rect',
  ROUNDRECT = 'roundRect',
  ELLIPSE = 'ellipse',
  TRIANGLE = 'triangle',
  PENTAGON = 'pentagon',
  RHOMBUS = 'rhombus',
  STAR = 'star',
}

interface ClipPath {
  [key: string]: {
    name: string;
    type: ClipPathTypes;
    style: string;
    radius?: string;
    createPath?: (width: number, height: number) => string;
  };
}

export const CLIPPATHS: ClipPath = {
  rect: {
    name: '矩形',
    type: ClipPathTypes.RECT,
    radius: '0',
    style: '',
  },
  rect2: {
    name: '矩形2',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 0%, 80% 0%, 100% 20%, 100% 100%, 0 100%)',
    createPath: (width: number, height: number) => {
      return `M 0 0 L ${width * 0.8} 0 L ${width} ${height * 0.2} L ${width} ${height} L 0 ${height} Z`;
    },
  },
  rect3: {
    name: '矩形3',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 0%, 80% 0%, 100% 20%, 100% 100%, 20% 100%, 0% 80%)',
    createPath: (width: number, height: number) => {
      return `M 0 0 L ${width * 0.8} 0 L ${width} ${height * 0.2} L ${width} ${height} L ${width * 0.2} ${height} L 0 ${height * 0.8} Z`;
    },
  },
  roundRect: {
    name: '圆角矩形',
    type: ClipPathTypes.RECT,
    radius: '10px',
    style: 'inset(0 round 10px)',
  },
  ellipse: {
    name: '圆形',
    type: ClipPathTypes.ELLIPSE,
    style: 'ellipse(50% 50% at 50% 50%)',
  },
```

### configs/chart.ts
```
import type { ChartData } from '@/lib/types/slides';

export const CHART_TYPE_MAP: Record<string, string> = {
  bar: '柱状图',
  column: '条形图',
  line: '折线图',
  area: '面积图',
  scatter: '散点图',
  pie: '饼图',
  ring: '环形图',
  radar: '雷达图',
};

export const CHART_DEFAULT_DATA: Record<string, ChartData> = {
  bar: {
    labels: ['类别1', '类别2', '类别3', '类别4', '类别5'],
    legends: ['系列1', '系列2'],
    series: [
      [12, 19, 5, 2, 18],
      [7, 11, 13, 21, 9],
    ],
  },
  column: {
    labels: ['类别1', '类别2', '类别3', '类别4', '类别5'],
    legends: ['系列1', '系列2'],
    series: [
      [12, 19, 5, 2, 18],
      [7, 11, 13, 21, 9],
    ],
  },
  line: {
    labels: ['类别1', '类别2', '类别3', '类别4', '类别5'],
    legends: ['系列1', '系列2'],
    series: [
      [12, 19, 5, 2, 18],
      [7, 11, 13, 21, 9],
    ],
  },
  pie: {
    labels: ['类别1', '类别2', '类别3', '类别4', '类别5'],
    legends: ['值'],
    series: [[12, 19, 5, 2, 18]],
  },
  ring: {
    labels: ['类别1', '类别2', '类别3', '类别4', '类别5'],
    legends: ['值'],
    series: [[12, 19, 5, 2, 18]],
  },
  area: {
    labels: ['类别1', '类别2', '类别3', '类别4', '类别5'],
    legends: ['系列1', '系列2'],
    series: [
      [12, 19, 5, 2, 18],
      [7, 11, 13, 21, 9],
    ],
  },
  radar: {
    labels: ['类别1', '类别2', '类别3', '类别4', '类别5'],
    legends: ['系列1', '系列2'],
    series: [
```

### configs/storage.ts
```
export const LOCALSTORAGE_KEY_DISCARDED_DB = 'MAIC_DISCARDED_DB';
```

### configs/shapes.ts
```
// Non-professional designers can use this app to draw basic shapes: https://github.com/pipipi-pikachu/svgPathCreator

import { ShapePathFormulasKeys } from '@/lib/types/slides';

export interface ShapePoolItem {
  viewBox: [number, number];
  path: string;
  special?: boolean;
  pathFormula?: ShapePathFormulasKeys;
  outlined?: boolean;
  pptxShapeType?: string;
  title?: string;
  withborder?: boolean;
}

interface ShapeListItem {
  type: string;
  children: ShapePoolItem[];
}

export interface ShapePathFormula {
  editable?: boolean;
  defaultValue?: number[];
  range?: [number, number][];
  relative?: string[];
  getBaseSize?: ((width: number, height: number) => number)[];
  formula: (width: number, height: number, values?: number[]) => string;
}

export const SHAPE_PATH_FORMULAS: Record<string, ShapePathFormula> = {
  [ShapePathFormulasKeys.ROUND_RECT]: {
    editable: true,
    defaultValue: [0.125],
    range: [[0, 0.5]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${height - radius} Q ${width} ${height} ${width - radius} ${height} L ${radius} ${height} Q 0 ${height} 0 ${height - radius} L 0 ${radius} Q 0 0 ${radius} 0 Z`;
    },
  },
  [ShapePathFormulasKeys.CUT_RECT_DIAGONAL]: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 0.95]],
    relative: ['right'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M 0 ${height - radius} L 0 0 L ${width - radius} 0 L ${width} ${radius} L ${width} ${height} L ${radius} ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.CUT_RECT_SINGLE]: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 1]],
    relative: ['right'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
```

### configs/symbol.ts
```
export const SYMBOL_LIST = [
  {
    key: 'letter',
    label: '字母',
    children: [
      [
        'α',
        'β',
        'γ',
        'δ',
        'ϵ',
        'ε',
        'ζ',
        'η',
        'θ',
        'ϑ',
        'ι',
        'κ',
        'λ',
        'μ',
        'ν',
        'ξ',
        'π',
        'ϖ',
        'ρ',
        'ϱ',
        'σ',
        'ς',
        'τ',
        'υ',
        'ϕ',
        'φ',
        'χ',
        'ψ',
        'ω',
      ],
      ['Γ', 'Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Υ', 'Φ', 'Ψ', 'Ω'],
      [
        '𝐀',
        '𝐁',
        '𝐂',
        '𝐃',
        '𝐄',
        '𝐅',
        '𝐆',
        '𝐇',
        '𝐈',
        '𝐉',
        '𝐊',
        '𝐋',
        '𝐌',
        '𝐍',
        '𝐎',
        '𝐏',
        '𝐐',
        '𝐑',
        '𝐒',
        '𝐓',
        '𝐔',
        '𝐕',
```

### configs/hotkey.ts
```
export const enum KEYS {
  C = 'C',
  X = 'X',
  Z = 'Z',
  Y = 'Y',
  A = 'A',
  G = 'G',
  L = 'L',
  F = 'F',
  D = 'D',
  B = 'B',
  P = 'P',
  O = 'O',
  R = 'R',
  T = 'T',
  MINUS = '-',
  EQUAL = '=',
  DIGIT_0 = '0',
  DELETE = 'DELETE',
  UP = 'ARROWUP',
  DOWN = 'ARROWDOWN',
  LEFT = 'ARROWLEFT',
  RIGHT = 'ARROWRIGHT',
  ENTER = 'ENTER',
  SPACE = ' ',
  TAB = 'TAB',
  BACKSPACE = 'BACKSPACE',
  ESC = 'ESCAPE',
  PAGEUP = 'PAGEUP',
  PAGEDOWN = 'PAGEDOWN',
  F5 = 'F5',
}

interface HotkeyItem {
  type: string;
  children: {
    label: string;
    value?: string;
  }[];
}

export const HOTKEY_DOC: HotkeyItem[] = [
  {
    type: '通用',
    children: [
      { label: '剪切', value: 'Ctrl + X' },
      { label: '复制', value: 'Ctrl + C' },
      { label: '粘贴', value: 'Ctrl + V' },
      { label: '粘贴为纯文本', value: 'Ctrl + Shift + V' },
      { label: '快速复制粘贴', value: 'Ctrl + D' },
      { label: '全选', value: 'Ctrl + A' },
      { label: '撤销', value: 'Ctrl + Z' },
      { label: '恢复', value: 'Ctrl + Y' },
      { label: '删除', value: 'Delete / Backspace' },
      { label: '多选', value: '按住 Ctrl 或 Shift' },
      { label: '打开搜索替换', value: 'Ctrl + F' },
      { label: '打印', value: 'Ctrl + P' },
      { label: '关闭弹窗', value: 'ESC' },
    ],
  },
```

### configs/mime.ts
```
export const MIME_MAP: Record<string, string> = {
  // Audio types
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'oga',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-aiff': 'aif',
  'audio/x-ms-wma': 'wma',
  'audio/midi': 'mid',

  // Video types
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/quicktime': 'mov',
  'video/x-ms-wmv': 'wmv',
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
};
```

### configs/lines.ts
```
import type { LinePoint, LineStyleType } from '@/lib/types/slides';

export interface LinePoolItem {
  path: string;
  style: LineStyleType;
  points: [LinePoint, LinePoint];
  isBroken?: boolean;
  isBroken2?: boolean;
  isCurve?: boolean;
  isCubic?: boolean;
}

interface PresetLine {
  type: string;
  children: LinePoolItem[];
}

export const LINE_LIST: PresetLine[] = [
  {
    type: '直线',
    children: [
      { path: 'M 0 0 L 20 20', style: 'solid', points: ['', ''] },
      { path: 'M 0 0 L 20 20', style: 'dashed', points: ['', ''] },
      { path: 'M 0 0 L 20 20', style: 'solid', points: ['', 'arrow'] },
      { path: 'M 0 0 L 20 20', style: 'dashed', points: ['', 'arrow'] },
      { path: 'M 0 0 L 20 20', style: 'solid', points: ['', 'dot'] },
    ],
  },
  {
    type: '折线、曲线',
    children: [
      {
        path: 'M 0 0 L 0 20 L 20 20',
        style: 'solid',
        points: ['', 'arrow'],
        isBroken: true,
      },
      {
        path: 'M 0 0 L 10 0 L 10 20 L 20 20',
        style: 'solid',
        points: ['', 'arrow'],
        isBroken2: true,
      },
      {
        path: 'M 0 0 Q 0 20 20 20',
        style: 'solid',
        points: ['', 'arrow'],
        isCurve: true,
      },
      {
        path: 'M 0 0 C 20 0 0 20 20 20',
        style: 'solid',
        points: ['', 'arrow'],
        isCubic: true,
      },
    ],
  },
];
```

### app/page.tsx
```
'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ImagePlus,
  Pencil,
  Trash2,
  Settings,
  Sun,
  Moon,
  Monitor,
  BotOff,
  ChevronUp,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { AgentBar } from '@/components/agent/agent-bar';
import { useTheme } from '@/lib/hooks/use-theme';
import { nanoid } from 'nanoid';
import { storePdfBlob } from '@/lib/utils/image-storage';
import type { UserRequirements } from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  getFirstSlideByStages,
} from '@/lib/utils/stage-storage';
import { ThumbnailSlide } from '@/components/slide-renderer/components/ThumbnailSlide';
import type { Slide } from '@/lib/types/slides';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';

const log = createLogger('Home');

const WEB_SEARCH_STORAGE_KEY = 'webSearchEnabled';
const LANGUAGE_STORAGE_KEY = 'generationLanguage';
const RECENT_OPEN_STORAGE_KEY = 'recentClassroomsOpen';

interface FormState {
  pdfFile: File | null;
  requirement: string;
  language: 'zh-CN' | 'en-US';
  webSearch: boolean;
```

### app/layout.tsx
```
import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { Toaster } from '@/components/ui/sonner';
import { ServerProvidersInit } from '@/components/server-providers-init';

const inter = localFont({
  src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  variable: '--font-sans',
  weight: '100 900',
});

export const metadata: Metadata = {
  title: 'OpenMAIC',
  description:
    'The open-source AI interactive classroom. Upload a PDF to instantly generate an immersive, multi-agent learning experience.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <ThemeProvider>
          <I18nProvider>
            <ServerProvidersInit />
            {children}
            <Toaster position="top-center" />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

### components/server-providers-init.tsx
```
'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);

  useEffect(() => {
    fetchServerProviders();
  }, [fetchServerProviders]);

  return null;
}
```

### components/header.tsx
```
'use client';

import {
  Settings,
  Sun,
  Moon,
  Monitor,
  ArrowLeft,
  Loader2,
  Download,
  FileDown,
  Package,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SettingsDialog } from './settings';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useExportPPTX } from '@/lib/export/use-export-pptx';

interface HeaderProps {
  readonly currentSceneTitle: string;
}

export function Header({ currentSceneTitle }: HeaderProps) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  // Model setup state
  const currentModelId = useSettingsStore((s) => s.modelId);
  const needsSetup = !currentModelId;

  // Export
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const scenes = useStageStore((s) => s.scenes);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);

  const canExport =
    scenes.length > 0 &&
    generatingOutlines.length === 0 &&
    failedOutlines.length === 0 &&
    Object.values(mediaTasks).every((task) => task.status === 'done' || task.status === 'failed');

  const languageRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  const handleClickOutside = useCallback(
```

### components/user-profile.tsx
```
'use client';

import { useState, useEffect, useRef } from 'react';
import { Pencil, Check, ImagePlus, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { toast } from 'sonner';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';

/** Check whether avatar is a custom upload (data-URL) */
function isCustomAvatar(avatar: string) {
  return avatar.startsWith('data:');
}

/** Max uploaded image size before we reject */
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MB

const FILE_INPUT_ID = 'user-avatar-upload';

export function UserProfileCard() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHydrated(true); // eslint-disable-line react-hooks/set-state-in-effect -- Store hydration on mount
  }, []);

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  const displayName = nickname || t('profile.defaultNickname');

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
```

### components/stage.tsx
```
'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useStageStore } from '@/lib/store';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { SceneSidebar } from './stage/scene-sidebar';
import { Header } from './header';
import { CanvasArea } from '@/components/canvas/canvas-area';
import { Roundtable } from '@/components/roundtable';
import { PlaybackEngine, computePlaybackView } from '@/lib/playback';
import type { EngineMode, TriggerEvent, Effect } from '@/lib/playback';
import { ActionEngine } from '@/lib/action/engine';
import { createAudioPlayer } from '@/lib/utils/audio-player';
import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
// Playback state persistence removed — refresh always starts from the beginning
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import { agentsToParticipants, useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { AlertTriangle } from 'lucide-react';
import { VisuallyHidden } from 'radix-ui';

/**
 * Stage Component
 *
 * The main container for the classroom/course.
 * Combines sidebar (scene navigation) and content area (scene viewer).
 * Supports two modes: autonomous and playback.
 */
export function Stage({
  onRetryOutline,
}: {
  onRetryOutline?: (outlineId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const { mode, getCurrentScene, scenes, currentSceneId, setCurrentSceneId, generatingOutlines } =
    useStageStore();
  const failedOutlines = useStageStore.use.failedOutlines();

  const currentScene = getCurrentScene();

  // Layout state from settings store (persisted via localStorage)
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
  const chatAreaWidth = useSettingsStore((s) => s.chatAreaWidth);
  const setChatAreaWidth = useSettingsStore((s) => s.setChatAreaWidth);
  const chatAreaCollapsed = useSettingsStore((s) => s.chatAreaCollapsed);
  const setChatAreaCollapsed = useSettingsStore((s) => s.setChatAreaCollapsed);

  // PlaybackEngine state
```

### lib/logger.ts
```
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function getMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return env in LOG_LEVELS ? (env as LogLevel) : 'info';
}

function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT === 'json';
}

function formatLine(level: LogLevel, tag: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const upperLevel = level.toUpperCase();
  const msg = args
    .map((a) =>
      a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a),
    )
    .join(' ');

  if (isJsonFormat()) {
    return JSON.stringify({ timestamp, level: upperLevel, tag, message: msg });
  }
  return `[${timestamp}] [${upperLevel}] [${tag}] ${msg}`;
}

export function createLogger(tag: string) {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[getMinLevel()]) return;

    const line = formatLine(level, tag, args);

    // Console output
    const fn =
      level === 'debug'
        ? console.debug
        : level === 'warn'
          ? console.warn
          : level === 'error'
            ? console.error
            : console.log;
    fn(line);
  };

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}
```

### app/generation-preview/page.tsx
```
'use client';

import { useEffect, useState, Suspense, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Sparkles, AlertCircle, AlertTriangle, ArrowLeft, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  loadImageMapping,
  loadPdfBlob,
  cleanupOldImages,
  storeImages,
} from '@/lib/utils/image-storage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { db } from '@/lib/utils/database';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { nanoid } from 'nanoid';
import type { Stage } from '@/lib/types/stage';
import type { SceneOutline, PdfImage, ImageMapping } from '@/lib/types/generation';
import { AgentRevealModal } from '@/components/agent/agent-reveal-modal';
import { createLogger } from '@/lib/logger';
import { type GenerationSessionState, ALL_STEPS, getActiveSteps } from './types';
import { StepVisualizer } from './components/visualizers';

const log = createLogger('GenerationPreview');

function GenerationPreviewContent() {
  const router = useRouter();
  const { t } = useI18n();
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [session, setSession] = useState<GenerationSessionState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isComplete] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [streamingOutlines, setStreamingOutlines] = useState<SceneOutline[] | null>(null);
  const [truncationWarnings, setTruncationWarnings] = useState<string[]>([]);
  const [webSearchSources, setWebSearchSources] = useState<Array<{ title: string; url: string }>>(
    [],
  );
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  const [generatedAgents, setGeneratedAgents] = useState<
    Array<{
      id: string;
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      priority: number;
```

### app/generation-preview/layout.tsx
```
// Force dynamic rendering since this page uses client-side hooks (useI18n)
export const dynamic = 'force-dynamic';

export default function GenerationPreviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
```

### app/generation-preview/types.ts
```
import { ScanLine, Search, Bot, FileText, LayoutPanelLeft, Clapperboard } from 'lucide-react';
import { useSettingsStore } from '@/lib/store/settings';
import type {
  SceneOutline,
  UserRequirements,
  PdfImage,
  ImageMapping,
} from '@/lib/types/generation';

// Session state stored in sessionStorage
export interface GenerationSessionState {
  sessionId: string;
  requirements: UserRequirements;
  pdfText: string;
  pdfImages?: PdfImage[];
  imageStorageIds?: string[];
  imageMapping?: ImageMapping;
  sceneOutlines?: SceneOutline[] | null;
  currentStep: 'generating' | 'complete';
  // PDF deferred parsing fields
  pdfStorageKey?: string;
  pdfFileName?: string;
  pdfProviderId?: string;
  pdfProviderConfig?: { apiKey?: string; baseUrl?: string };
  // Web search context
  researchContext?: string;
  researchSources?: Array<{ title: string; url: string }>;
}

export type GenerationStep = {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  type: 'analysis' | 'writing' | 'visual';
};

export const ALL_STEPS: GenerationStep[] = [
  {
    id: 'pdf-analysis',
    title: 'generation.analyzingPdf',
    description: 'generation.analyzingPdfDesc',
    icon: ScanLine,
    type: 'analysis',
  },
  {
    id: 'web-search',
    title: 'generation.webSearching',
    description: 'generation.webSearchingDesc',
    icon: Search,
    type: 'analysis',
  },
  {
    id: 'agent-generation',
    title: 'generation.agentGeneration',
    description: 'generation.agentGenerationDesc',
    icon: Bot,
    type: 'writing',
  },
  {
```

### app/classroom/[id]/page.tsx
```
'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;

  const { loadFromStorage } = useStageStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(async () => {
    try {
      await loadFromStorage(classroomId);

      // If IndexedDB had no data, try server-side storage (API-generated classrooms)
      if (!useStageStore.getState().stage) {
        log.info('No IndexedDB data, trying server-side storage for:', classroomId);
        try {
          const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.classroom) {
              const { stage, scenes } = json.classroom;
              useStageStore.getState().setStage(stage);
              useStageStore.setState({
                scenes,
                currentSceneId: scenes[0]?.id ?? null,
              });
              log.info('Loaded from server-side storage:', classroomId);
            }
          }
        } catch (fetchErr) {
          log.warn('Server-side storage fetch failed:', fetchErr);
        }
      }

      // Restore completed media generation tasks from IndexedDB
```

### app/generation-preview/components/visualizers.tsx
```
'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ScanLine,
  Search,
  Globe,
  MousePointer2,
  BarChart3,
  Puzzle,
  Clapperboard,
  MessageSquare,
  Focus,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SceneOutline } from '@/lib/types/generation';

// Step-specific visualizers
export function StepVisualizer({
  stepId,
  outlines,
  webSearchSources,
}: {
  stepId: string;
  outlines?: SceneOutline[] | null;
  webSearchSources?: Array<{ title: string; url: string }>;
}) {
  switch (stepId) {
    case 'pdf-analysis':
      return <PdfScanVisualizer />;
    case 'web-search':
      return <WebSearchVisualizer sources={webSearchSources || []} />;
    case 'outline':
      return <StreamingOutlineVisualizer outlines={outlines || []} />;
    case 'agent-generation':
      return <AgentGenerationVisualizer />;
    case 'slide-content':
      return <ContentVisualizer />;
    case 'actions':
      return <ActionsVisualizer />;
    default:
      return null;
  }
}

// PDF: Document with scanning laser line
function PdfScanVisualizer() {
  return (
    <div className="size-32 relative flex items-center justify-center">
      <motion.div
        className="absolute inset-2 bg-cyan-500/5 rounded-2xl blur-lg"
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 2, repeat: Infinity }}
      />
      <div className="w-20 h-28 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-xl relative overflow-hidden">
        <div className="p-3 space-y-2 mt-1">
          {[80, 60, 90, 45, 70].map((w, i) => (
            <motion.div
```

### app/api/generate-classroom/route.ts
```
import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),
      ...(rawBody.language ? { language: rawBody.language } : {}),
    };
    const { requirement } = body;

    if (!requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const job = await createClassroomGenerationJob(jobId, body);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() => runClassroomGenerationJob(jobId, body, baseUrl));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
```

### app/api/verify-model/route.ts
```
import { NextRequest } from 'next/server';
import { generateText } from 'ai';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModel } from '@/lib/server/resolve-model';
const log = createLogger('Verify Model');

export async function POST(req: NextRequest) {
  try {
    const { apiKey, baseUrl, model, providerType, requiresApiKey } = await req.json();

    if (!model) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Model name is required');
    }

    // Parse model string and resolve server-side fallback
    let languageModel;
    try {
      const result = resolveModel({
        modelString: model,
        apiKey: apiKey || '',
        baseUrl: baseUrl || undefined,
        providerType,
        requiresApiKey,
      });
      languageModel = result.model;
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        401,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Send a minimal test message
    const { text } = await generateText({
      model: languageModel,
      prompt: 'Say "OK" if you can hear me.',
    });

    return apiSuccess({
      message: 'Connection successful',
      response: text,
    });
  } catch (error) {
    log.error('API test error:', error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      // Parse common error messages
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'API key is invalid or expired';
      } else if (error.message.includes('404') || error.message.includes('not found')) {
        errorMessage = 'Model not found or API endpoint error';
      } else if (error.message.includes('429')) {
        errorMessage = 'API rate limit exceeded, please try again later';
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to API server, please check the Base URL';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Connection timed out, please check your network';
```

### app/api/classroom/route.ts
```
import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { stage, scenes } = body;

    if (!stage || !scenes) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    const id = stage.id || randomUUID();
    const baseUrl = buildRequestOrigin(request);

    const persisted = await persistClassroom({ id, stage: { ...stage, id }, scenes }, baseUrl);

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

```

### app/api/verify-pdf-provider/route.ts
```
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolvePDFApiKey, resolvePDFBaseUrl } from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('Verify PDF Provider');

export async function POST(req: NextRequest) {
  try {
    const { providerId, apiKey, baseUrl } = await req.json();

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider ID is required');
    }

    const clientBaseUrl = (baseUrl as string | undefined) || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const resolvedBaseUrl = clientBaseUrl ? clientBaseUrl : resolvePDFBaseUrl(providerId, baseUrl);
    if (!resolvedBaseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    const resolvedApiKey = clientBaseUrl
      ? (apiKey as string | undefined) || ''
      : resolvePDFApiKey(providerId, apiKey);

    const headers: Record<string, string> = {};
    if (resolvedApiKey) {
      headers['Authorization'] = `Bearer ${resolvedApiKey}`;
    }

    const response = await fetch(resolvedBaseUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    // MinerU's FastAPI root returns 404 (no root route), but the server is reachable.
    // Any HTTP response (including 404) means the server is up.
    return apiSuccess({
      message: 'Connection successful',
      status: response.status,
    });
  } catch (error) {
    log.error('PDF provider test error:', error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED')) {
```

### app/api/proxy-media/route.ts
```
/**
 * Media Proxy API
 *
 * Server-side proxy for fetching remote media URLs (images/videos).
 * Required because browser fetch() to remote CDN URLs fails with CORS errors.
 * The media orchestrator uses this to download generated media as blobs
 * for IndexedDB persistence.
 *
 * POST /api/proxy-media
 * Body: { url: string }
 * Response: Binary blob with appropriate Content-Type
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('ProxyMedia');

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== 'string') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing or invalid url');
    }

    // Block local/private network URLs to prevent SSRF
    const ssrfError = validateUrlForSSRF(url);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    // Disable redirect following to prevent redirect-to-internal attacks
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }
    if (!response.ok) {
      return apiError('UPSTREAM_ERROR', 502, `Upstream returned ${response.status}`);
    }

    const blob = await response.blob();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(blob, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(blob.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    log.error('Proxy media error:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
```

### app/api/chat/route.ts
```
/**
 * Stateless Chat API Endpoint
 *
 * POST /api/chat - Send message, receive SSE stream
 *
 * This endpoint:
 * 1. Receives full state from client (messages + storeState)
 * 2. Runs single-pass generation
 * 3. Streams events as SSE (text deltas + tool calls)
 *
 * Fully stateless: interruption is handled by the client aborting
 * the fetch request, which triggers req.signal on the server side.
 */

import { NextRequest } from 'next/server';
import { statelessGenerate } from '@/lib/orchestration/stateless-generate';
import { getModel, parseModelString } from '@/lib/ai/providers';
import { resolveApiKey, resolveBaseUrl, resolveProxy } from '@/lib/server/provider-config';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
const log = createLogger('Chat API');

// Allow streaming responses up to 60 seconds
export const maxDuration = 60;

/**
 * POST /api/chat
 * Send a message and receive SSE stream of generation events
 *
 * Request body: StatelessChatRequest
 * {
 *   messages: UIMessage[],
 *   storeState: { stage, scenes, currentSceneId, mode },
 *   config: { agentIds, sessionType? },
 *   apiKey: string,
 *   baseUrl?: string,
 *   model?: string
 * }
 *
 * Response: SSE stream of StatelessEvent
 */
export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const body: StatelessChatRequest = await req.json();

    // Validate required fields
    if (!body.messages || !Array.isArray(body.messages)) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: messages');
    }

    if (!body.storeState) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: storeState');
    }

    if (!body.config || !body.config.agentIds || body.config.agentIds.length === 0) {
```

### app/api/verify-image-provider/route.ts
```
/**
 * Verify Image Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating images.
 *
 * POST /api/verify-image-provider
 *
 * Headers:
 *   x-image-provider: ImageProviderId
 *   x-image-model: string (optional)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { testImageConnectivity } from '@/lib/media/image-providers';
import { resolveImageApiKey, resolveImageBaseUrl } from '@/lib/server/provider-config';
import type { ImageProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VerifyImageProvider');

export async function POST(request: NextRequest) {
  try {
    const providerId = (request.headers.get('x-image-provider') || 'seedream') as ImageProviderId;
    const model = request.headers.get('x-image-model') || undefined;
    const clientApiKey = request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = request.headers.get('x-base-url') || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = clientBaseUrl
      ? clientApiKey || ''
      : resolveImageApiKey(providerId, clientApiKey);
    const baseUrl = clientBaseUrl ? clientBaseUrl : resolveImageBaseUrl(providerId, clientBaseUrl);

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const result = await testImageConnectivity({
      providerId,
      apiKey,
      baseUrl,
      model,
    });

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

```

### app/api/server-providers/route.ts
```
import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
} from '@/lib/server/provider-config';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('ServerProviders');

export async function GET() {
  try {
    return apiSuccess({
      providers: getServerProviders(),
      tts: getServerTTSProviders(),
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: getServerImageProviders(),
      video: getServerVideoProviders(),
      webSearch: getServerWebSearchProviders(),
    });
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
```

### app/api/azure-voices/route.ts
```
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError, apiSuccess } from '@/lib/server/api-response';
const log = createLogger('Azure Voices');

export const maxDuration = 30;

/**
 * Azure TTS Voice List API
 * Fetches available voices from Azure Speech Services
 */
export async function POST(req: NextRequest) {
  try {
    const { apiKey, baseUrl } = await req.json();

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'API Key is required');
    }

    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    // Validate baseUrl against SSRF
    const ssrfError = validateUrlForSSRF(baseUrl);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    // Call Azure voices list endpoint; disable redirect following to prevent SSRF via redirect
    const response = await fetch(`${baseUrl}/cognitiveservices/voices/list`, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    if (!response.ok) {
      const errorText = await response.text();
      return apiError(
        'UPSTREAM_ERROR',
        response.status,
        'Failed to fetch voices from Azure',
        errorText || response.statusText,
      );
    }

    const voices = await response.json();

    return apiSuccess({ voices });
  } catch (error) {
    log.error('API error:', error);
    return apiError(
      'INTERNAL_ERROR',
```

### app/api/quiz-grade/route.ts
```
/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

interface GradeResponse {
  score: number;
  comment: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GradeRequest;
    const { question, userAnswer, points, commentPrompt, language } = body;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
    }

    // Resolve model from request headers
    const { model: languageModel } = resolveModelFromHeaders(req);

    const isZh = language === 'zh-CN';

    const systemPrompt = isZh
      ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
      : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

    const userPrompt = isZh
      ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
      : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

    const result = await callLLM(
      {
        model: languageModel,
```

### app/api/health/route.ts
```
import { apiSuccess } from '@/lib/server/api-response';

const version = process.env.npm_package_version || '0.1.0';

export async function GET() {
  return apiSuccess({ status: 'ok', version });
}
```

### app/api/web-search/route.ts
```
/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using Tavily search.
 */

import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const log = createLogger('WebSearch');

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { query, apiKey: clientApiKey } = body as {
      query?: string;
      apiKey?: string;
    };

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    const apiKey = resolveWebSearchApiKey(clientApiKey);
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        400,
        'Tavily API key is not configured. Set it in Settings → Web Search or set TAVILY_API_KEY env var.',
      );
    }

    const result = await searchWithTavily({ query: query.trim(), apiKey });
    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    log.error('[WebSearch] Error:', err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
```

### app/api/parse-pdf/route.ts
```
import { NextRequest } from 'next/server';
import { parsePDF } from '@/lib/pdf/pdf-providers';
import { resolvePDFApiKey, resolvePDFBaseUrl } from '@/lib/server/provider-config';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
const log = createLogger('Parse PDF');

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      log.error('Invalid Content-Type for PDF upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data, got "${contentType}"`,
      );
    }

    const formData = await req.formData();
    const pdfFile = formData.get('pdf') as File | null;
    const providerId = formData.get('providerId') as PDFProviderId | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!pdfFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'No PDF file provided');
    }

    // providerId is required from the client — no server-side store to fall back to
    const effectiveProviderId = providerId || ('unpdf' as PDFProviderId);

    const clientBaseUrl = baseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      apiKey: clientBaseUrl
        ? apiKey || ''
        : resolvePDFApiKey(effectiveProviderId, apiKey || undefined),
      baseUrl: clientBaseUrl
        ? clientBaseUrl
        : resolvePDFBaseUrl(effectiveProviderId, baseUrl || undefined),
    };

    // Convert PDF to buffer
    const arrayBuffer = await pdfFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Parse PDF using the provider system
    const result = await parsePDF(config, buffer);

```

### app/api/transcription/route.ts
```
import { NextRequest } from 'next/server';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import { resolveASRApiKey, resolveASRBaseUrl } from '@/lib/server/provider-config';
import type { ASRProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
const log = createLogger('Transcription');

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    const providerId = formData.get('providerId') as ASRProviderId | null;
    const language = formData.get('language') as string | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!audioFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Audio file is required');
    }

    // providerId is required from the client — no server-side store to fall back to
    const effectiveProviderId = providerId || ('openai-whisper' as ASRProviderId);

    const clientBaseUrl = baseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      language: language || 'auto',
      apiKey: clientBaseUrl
        ? apiKey || ''
        : resolveASRApiKey(effectiveProviderId, apiKey || undefined),
      baseUrl: clientBaseUrl
        ? clientBaseUrl
        : resolveASRBaseUrl(effectiveProviderId, baseUrl || undefined),
    };

    // Convert audio file to buffer
    const arrayBuffer = await audioFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Transcribe using the provider system
    const result = await transcribeAudio(config, buffer);

    return apiSuccess({ text: result.text });
  } catch (error) {
    log.error('Transcription error:', error);
    return apiError(
      'TRANSCRIPTION_FAILED',
      500,
      'Transcription failed',
```

### app/api/verify-video-provider/route.ts
```
/**
 * Verify Video Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating video.
 *
 * POST /api/verify-video-provider
 *
 * Headers:
 *   x-video-provider: VideoProviderId
 *   x-video-model: string (optional)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { testVideoConnectivity } from '@/lib/media/video-providers';
import { resolveVideoApiKey, resolveVideoBaseUrl } from '@/lib/server/provider-config';
import type { VideoProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VerifyVideoProvider');

export async function POST(request: NextRequest) {
  try {
    const providerId = (request.headers.get('x-video-provider') || 'seedance') as VideoProviderId;
    const model = request.headers.get('x-video-model') || undefined;
    const clientApiKey = request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = request.headers.get('x-base-url') || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = clientBaseUrl
      ? clientApiKey || ''
      : resolveVideoApiKey(providerId, clientApiKey);
    const baseUrl = clientBaseUrl ? clientBaseUrl : resolveVideoBaseUrl(providerId, clientBaseUrl);

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const result = await testVideoConnectivity({
      providerId,
      apiKey,
      baseUrl,
      model,
    });

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

```

### app/api/generate-classroom/[jobId]/route.ts
```
import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isValidClassroomJobId,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;

    if (!isValidClassroomJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
    }

    const job = await readClassroomGenerationJob(jobId);
    if (!job) {
      return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
    }

    const pollUrl = `${buildRequestOrigin(req)}/api/generate-classroom/${jobId}`;

    return apiSuccess({
      jobId: job.id,
      status: job.status,
      step: job.step,
      progress: job.progress,
      message: job.message,
      pollUrl,
      pollIntervalMs: 5000,
      scenesGenerated: job.scenesGenerated,
      totalScenes: job.totalScenes,
      result: job.result,
      error: job.error,
      done: job.status === 'succeeded' || job.status === 'failed',
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to retrieve classroom generation job',
      error instanceof Error ? error.message : String(error),
    );
  }
}
```

### app/api/pbl/chat/route.ts
```
/**
 * PBL Runtime Chat API
 *
 * Handles @mention routing during PBL runtime.
 * Students @question or @judge an agent, and this endpoint generates a response.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import type { PBLAgent, PBLIssue } from '@/lib/pbl/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
const log = createLogger('PBL Chat');

interface PBLChatRequest {
  message: string;
  agent: PBLAgent;
  currentIssue: PBLIssue | null;
  recentMessages: { agent_name: string; message: string }[];
  userRole: string;
  agentType?: 'question' | 'judge';
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PBLChatRequest;
    const { message, agent, currentIssue, recentMessages, userRole, agentType } = body;

    if (!message || !agent) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Message and agent are required');
    }

    // Get model config from headers
    const { model } = resolveModelFromHeaders(req);

    // Build context for the agent, differentiating question vs judge
    let issueContext = '';
    if (currentIssue) {
      issueContext = `\n\n## Current Issue\nTitle: ${currentIssue.title}\nDescription: ${currentIssue.description}\nPerson in Charge: ${currentIssue.person_in_charge}`;
      if (currentIssue.generated_questions) {
        if (agentType === 'judge') {
          issueContext += `\n\nQuestions to Evaluate Against:\n${currentIssue.generated_questions}`;
        } else {
          issueContext += `\n\nGenerated Questions:\n${currentIssue.generated_questions}`;
        }
      }
    }

    const recentContext =
      recentMessages.length > 0
        ? `\n\n## Recent Conversation\n${recentMessages
            .slice(-5)
            .map((m) => `${m.agent_name}: ${m.message}`)
            .join('\n')}`
        : '';

    const systemPrompt = `${agent.system_prompt}${issueContext}${recentContext}${userRole ? `\n\nThe student's role is: ${userRole}` : ''}`;

    const result = await callLLM(
```

### app/api/generate/scene-outlines-stream/route.ts
```
/**
 * Scene Outlines Streaming API (SSE)
 *
 * Streams outline generation via Server-Sent Events.
 * Emits individual outline objects as they're parsed from the LLM response,
 * so the frontend can display them incrementally.
 *
 * SSE events:
 *   { type: 'outline', data: SceneOutline, index: number }
 *   { type: 'done', outlines: SceneOutline[] }
 *   { type: 'error', error: string }
 */

import { NextRequest } from 'next/server';
import { streamLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import {
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
  uniquifyMediaElementIds,
  formatTeacherPersonaForPrompt,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { nanoid } from 'nanoid';
import type {
  UserRequirements,
  PdfImage,
  SceneOutline,
  ImageMapping,
} from '@/lib/types/generation';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
const log = createLogger('Outlines Stream');

export const maxDuration = 300;

/**
 * Incremental JSON array parser.
 * Extracts complete top-level objects from a partially-streamed JSON array.
 * Returns newly found objects (skipping `alreadyParsed` count).
 */
function extractNewOutlines(buffer: string, alreadyParsed: number): SceneOutline[] {
  const results: SceneOutline[] = [];

  // Find the start of the JSON array (skip any markdown fencing)
  const stripped = buffer.replace(/^[\s\S]*?(?=\[)/, '');
  const arrayStart = stripped.indexOf('[');
  if (arrayStart === -1) return results;

  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  let objectCount = 0;

  for (let i = arrayStart + 1; i < stripped.length; i++) {
    const char = stripped[i];
```

### app/api/generate/agent-profiles/route.ts
```
/**
 * Agent Profiles Generation API
 *
 * Generates agent profiles (teacher, assistant, student) for a course stage
 * based on stage info and scene outlines.
 */

import { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('Agent Profiles API');

export const maxDuration = 120;

const COLOR_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#8b5cf6',
  '#f97316',
  '#14b8a6',
  '#e11d48',
  '#6366f1',
  '#84cc16',
  '#a855f7',
];

interface RequestBody {
  stageInfo: { name: string; description?: string };
  sceneOutlines?: { title: string; description?: string }[];
  language: string;
  availableAvatars: string[];
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  // Remove markdown code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RequestBody;
    const { stageInfo, sceneOutlines, language, availableAvatars } = body;

    // ── Validate required fields ──
    if (!stageInfo?.name) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageInfo.name is required');
    }
    if (!language) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'language is required');
```

### app/api/generate/tts/route.ts
```
/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/generate/tts
 */

import { NextRequest } from 'next/server';
import { generateTTS } from '@/lib/audio/tts-providers';
import { resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('TTS API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text, audioId, ttsProviderId, ttsVoice, ttsSpeed, ttsApiKey, ttsBaseUrl } = body as {
      text: string;
      audioId: string;
      ttsProviderId: TTSProviderId;
      ttsVoice: string;
      ttsSpeed?: number;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
    };

    // Validate required fields
    if (!text || !audioId || !ttsProviderId || !ttsVoice) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing required fields: text, audioId, ttsProviderId, ttsVoice',
      );
    }

    // Reject browser-native TTS — must be handled client-side
    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
    }

    const clientBaseUrl = ttsBaseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = clientBaseUrl
      ? ttsApiKey || ''
      : resolveTTSApiKey(ttsProviderId, ttsApiKey || undefined);
    const baseUrl = clientBaseUrl
```

### app/api/generate/scene-content/route.ts
```
/**
 * Scene Content Generation API
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline.
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions — use /api/generate/scene-actions for that.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent,
  buildVisionUserContent,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { SceneOutline, PdfImage, ImageMapping } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('Scene Content API');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      outline: rawOutline,
      allOutlines,
      pdfImages,
      imageMapping,
      stageInfo,
      stageId,
      agents,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      stageInfo: {
        name: string;
        description?: string;
        language?: string;
        style?: string;
      };
      stageId: string;
      agents?: AgentInfo[];
    };

    // Validate required fields
    if (!rawOutline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
```

### app/api/generate/video/route.ts
```
/**
 * Video Generation API
 *
 * Generates a video from a text prompt using the specified provider.
 * Uses async task pattern (submit → poll) so maxDuration is set to 5 minutes.
 *
 * POST /api/generate/video
 *
 * Headers:
 *   x-video-provider: VideoProviderId (default: 'seedance')
 *   x-video-model: string (optional model override)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, duration?, aspectRatio?, resolution? }
 * Response: { success: boolean, result?: VideoGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { resolveVideoApiKey, resolveVideoBaseUrl } from '@/lib/server/provider-config';
import type { VideoProviderId, VideoGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VideoGeneration API');

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as VideoGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    const providerId = (request.headers.get('x-video-provider') || 'seedance') as VideoProviderId;
    const clientApiKey = request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = request.headers.get('x-base-url') || undefined;
    const clientModel = request.headers.get('x-video-model') || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = clientBaseUrl
      ? clientApiKey || ''
      : resolveVideoApiKey(providerId, clientApiKey);
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for video provider: ${providerId}`,
      );
    }
```

### app/api/generate/scene-actions/route.ts
```
/**
 * Scene Actions Generation API
 *
 * Generates actions for a scene given its outline and content,
 * then assembles the complete Scene object.
 * This is the second half of the two-step scene generation pipeline.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import {
  generateSceneActions,
  buildCompleteScene,
  buildVisionUserContent,
  type SceneGenerationContext,
  type AgentInfo,
} from '@/lib/generation/generation-pipeline';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
} from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('Scene Actions API');

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      outline,
      allOutlines,
      content,
      stageId,
      agents,
      previousSpeeches: incomingPreviousSpeeches,
      userProfile,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      content:
        | GeneratedSlideContent
        | GeneratedQuizContent
        | GeneratedInteractiveContent
        | GeneratedPBLContent;
      stageId: string;
      agents?: AgentInfo[];
      previousSpeeches?: string[];
      userProfile?: string;
    };

    // Validate required fields
    if (!outline) {
```

### app/api/generate/image/route.ts
```
/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/generate/image
 *
 * Headers:
 *   x-image-provider: ImageProviderId (default: 'seedream')
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { generateImage, aspectRatioToDimensions } from '@/lib/media/image-providers';
import { resolveImageApiKey, resolveImageBaseUrl } from '@/lib/server/provider-config';
import type { ImageProviderId, ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('ImageGeneration API');

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ImageGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    const providerId = (request.headers.get('x-image-provider') || 'seedream') as ImageProviderId;
    const clientApiKey = request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = request.headers.get('x-base-url') || undefined;
    const clientModel = request.headers.get('x-image-model') || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = clientBaseUrl
      ? clientApiKey || ''
      : resolveImageApiKey(providerId, clientApiKey);
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for image provider: ${providerId}`,
      );
    }

```

### components/ui/progress.tsx
```
'use client';

import * as React from 'react';
import { Progress as ProgressPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        'bg-muted h-1.5 rounded-full relative flex w-full items-center overflow-x-hidden',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary size-full flex-1 transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
```

### components/ui/input.tsx
```
import * as React from 'react';

import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 h-9 rounded-md border bg-transparent px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] file:h-7 file:text-sm file:font-medium focus-visible:ring-[3px] aria-invalid:ring-[3px] md:text-sm file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
```

### components/ui/select.tsx
```
'use client';

import * as React from 'react';
import { Select as SelectPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from 'lucide-react';

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn('scroll-my-1 p-1', className)}
      {...props}
    />
  );
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default';
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 gap-1.5 rounded-md border bg-transparent py-2 pr-2 pl-2.5 text-sm shadow-xs transition-[color,box-shadow] focus-visible:ring-[3px] aria-invalid:ring-[3px] data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:flex *:data-[slot=select-value]:gap-1.5 [&_svg:not([class*='size-'])]:size-4 flex w-fit items-center justify-between whitespace-nowrap outline-none disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="text-muted-foreground size-4 pointer-events-none" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'item-aligned',
  align = 'center',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
```

### components/ui/dropdown-menu.tsx
```
'use client';

import * as React from 'react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { CheckIcon, ChevronRightIcon } from 'lucide-react';

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  align = 'start',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground min-w-32 rounded-md p-1 shadow-md ring-1 duration-100 z-50 max-h-(--radix-dropdown-menu-content-available-height) w-(--radix-dropdown-menu-trigger-width) origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto data-[state=closed]:overflow-hidden',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
```

### components/ui/slider.tsx
```
'use client';

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
```

### components/ui/button-group.tsx
```
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';

const buttonGroupVariants = cva(
  "has-[>[data-slot=button-group]]:gap-2 has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-md flex w-fit items-stretch [&>*]:focus-visible:z-10 [&>*]:focus-visible:relative [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1",
  {
    variants: {
      orientation: {
        horizontal:
          '[&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-md! [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none',
        vertical:
          '[&>[data-slot]:not(:has(~[data-slot]))]:rounded-b-md! flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:first-child)]:border-t-0 [&>*:not(:last-child)]:rounded-b-none',
      },
    },
    defaultVariants: {
      orientation: 'horizontal',
    },
  },
);

function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  );
}

function ButtonGroupText({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'div';

  return (
    <Comp
      className={cn(
        "bg-muted gap-2 rounded-md border px-2.5 text-sm font-medium shadow-xs [&_svg:not([class*='size-'])]:size-4 flex items-center [&_svg]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupSeparator({
```

### components/ui/tooltip.tsx
```
'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-md px-3 py-1.5 text-xs bg-foreground text-background z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin)',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground z-50 translate-y-[calc(-50%_-_2px)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
```

### components/ui/context-menu.tsx
```
'use client';

import * as React from 'react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { ChevronRightIcon, CheckIcon } from 'lucide-react';

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn('select-none', className)}
      {...props}
    />
  );
}

function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuPortal({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground min-w-36 rounded-md p-1 shadow-md ring-1 duration-100 z-50 max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
```

### components/ui/textarea.tsx
```
import * as React from 'react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-md border bg-transparent px-2.5 py-2 text-base shadow-xs transition-[color,box-shadow] focus-visible:ring-[3px] aria-invalid:ring-[3px] md:text-sm placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
```

### components/ui/label.tsx
```
'use client';

import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'gap-2 text-sm leading-none font-medium group-data-[disabled=true]:opacity-50 peer-disabled:opacity-50 flex items-center select-none group-data-[disabled=true]:pointer-events-none peer-disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
```

### components/ui/switch.tsx
```
'use client';

import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';

import { cn } from '@/lib/utils';

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
```

### components/ui/sonner.tsx
```
'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
```

### components/ui/combobox.tsx
```
'use client';

import * as React from 'react';
import { Combobox as ComboboxPrimitive } from '@base-ui/react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { ChevronDownIcon, XIcon, CheckIcon } from 'lucide-react';

const Combobox = ComboboxPrimitive.Root;

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("[&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      {children}
      <ChevronDownIcon className="text-muted-foreground size-4 pointer-events-none" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroupButton variant="ghost" size="icon-xs" />}
      className={cn(className)}
      {...props}
    >
      <XIcon className="pointer-events-none" />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxInput({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  ...props
}: ComboboxPrimitive.Input.Props & {
  showTrigger?: boolean;
  showClear?: boolean;
}) {
  return (
    <InputGroup className={cn('w-auto', className)}>
```

### components/ui/badge.tsx
```
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'h-5 gap-1 rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive overflow-hidden group/badge',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive:
          'bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20',
        outline: 'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground',
        ghost: 'hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
```

### components/ui/scroll-area.tsx
```
'use client';

import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        'data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent flex touch-none p-px transition-colors select-none',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="rounded-full bg-border relative flex-1"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
```

### components/ui/tabs.tsx
```
'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('gap-2 group/tabs flex data-[orientation=horizontal]:flex-col', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  'rounded-lg p-[3px] group-data-horizontal/tabs:h-9 data-[variant=line]:rounded-none group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col',
  {
    variants: {
      variant: {
        default: 'bg-muted',
        line: 'gap-1 bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function TabsList({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg:not([class*='size-'])]:size-4 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center whitespace-nowrap transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        'group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent',
```

### components/ui/separator.tsx
```
'use client';

import * as React from 'react';
import { Separator as SeparatorPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
```

### components/ui/popover.tsx
```
'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
```

### components/ui/collapsible.tsx
```
'use client';

import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
```

### components/ui/alert-dialog.tsx
```
'use client';

import * as React from 'react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: 'default' | 'sm';
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 bg-background ring-foreground/10 gap-6 rounded-xl p-6 ring-1 duration-100 data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-lg group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 outline-none',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}
```

### components/ui/command.tsx
```
'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group';
import { SearchIcon, CheckIcon } from 'lucide-react';

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'bg-popover text-popover-foreground rounded-xl! p-1 flex size-full flex-col overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn('rounded-xl! top-1/3 translate-y-0 overflow-hidden p-0', className)}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
```

### components/ui/dialog.tsx
```
'use client';

import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { XIcon } from 'lucide-react';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 isolate z-50',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'bg-background data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 grid max-w-3/4 gap-6 rounded-xl p-6 text-sm ring-1 duration-100 fixed top-1/2 left-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2',
          className,
        )}
        {...props}
      >
```

### components/ui/alert.tsx
```
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  "grid gap-0.5 rounded-lg border px-4 py-3 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4 w-full relative group/alert",
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive:
          'text-destructive bg-card *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'font-medium group-has-[>svg]/alert:col-start-2 [&_a]:hover:text-foreground [&_a]:underline [&_a]:underline-offset-3',
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-muted-foreground text-sm text-balance md:text-pretty [&_p:not(:last-child)]:mb-4 [&_a]:hover:text-foreground [&_a]:underline [&_a]:underline-offset-3',
        className,
      )}
      {...props}
    />
  );
```

### components/ui/checkbox.tsx
```
'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn('flex items-center justify-center text-current')}>
      <Check className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
```

### components/ui/button.tsx
```
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-md border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-[3px] aria-invalid:ring-[3px] [&_svg:not([class*='size-'])]:size-4 inline-flex items-center justify-center whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 aria-expanded:bg-muted aria-expanded:text-foreground shadow-xs',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive:
          'bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        lg: 'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        icon: 'size-9',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
```

### components/ui/avatar.tsx
```
'use client';

import * as React from 'react';
import { Avatar as AvatarPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Avatar({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: 'default' | 'sm' | 'lg';
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        'size-8 rounded-full after:rounded-full data-[size=lg]:size-10 data-[size=sm]:size-6 after:border-border group/avatar relative flex shrink-0 select-none after:absolute after:inset-0 after:border after:mix-blend-darken dark:after:mix-blend-lighten',
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn('rounded-full aspect-square size-full object-cover', className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        'bg-muted text-muted-foreground rounded-full flex size-full items-center justify-center text-sm group-data-[size=sm]/avatar:text-xs',
        className,
      )}
      {...props}
    />
  );
}

function AvatarBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        'bg-primary text-primary-foreground ring-background absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-blend-color ring-2 select-none',
        'group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden',
```

### components/ui/input-group.tsx
```
'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        'border-input dark:bg-input/30 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[[data-slot][aria-invalid=true]]:border-destructive dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 h-9 rounded-md border shadow-xs transition-[color,box-shadow] has-[[data-slot=input-group-control]:focus-visible]:ring-[3px] has-[[data-slot][aria-invalid=true]]:ring-[3px] has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5 [[data-slot=combobox-content]_&]:focus-within:border-inherit [[data-slot=combobox-content]_&]:focus-within:ring-0 group/input-group relative flex w-full min-w-0 items-center outline-none has-[>textarea]:h-auto',
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "text-muted-foreground h-auto gap-2 py-1.5 text-sm font-medium group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4 flex cursor-text items-center justify-center select-none",
  {
    variants: {
      align: {
        'inline-start': 'pl-2 has-[>button]:ml-[-0.25rem] has-[>kbd]:ml-[-0.15rem] order-first',
        'inline-end': 'pr-2 has-[>button]:mr-[-0.25rem] has-[>kbd]:mr-[-0.15rem] order-last',
        'block-start':
          'px-2.5 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2 order-first w-full justify-start',
        'block-end':
          'px-2.5 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2 order-last w-full justify-start',
      },
    },
    defaultVariants: {
      align: 'inline-start',
    },
  },
);

function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) {
          return;
        }
        e.currentTarget.parentElement?.querySelector('input')?.focus();
      }}
```

### components/ui/field.tsx
```
'use client';

import { useMemo } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        'gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3 flex flex-col',
        className,
      )}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        'mb-3 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base',
        className,
      )}
      {...props}
    />
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        'gap-7 data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4 group/field-group @container/field-group flex w-full flex-col',
        className,
      )}
      {...props}
    />
  );
}

const fieldVariants = cva('data-[invalid=true]:text-destructive gap-3 group/field flex w-full', {
  variants: {
    orientation: {
      vertical: 'flex-col [&>*]:w-full [&>.sr-only]:w-auto',
      horizontal:
        'flex-row items-center [&>[data-slot=field-label]]:flex-auto has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      responsive:
```

### components/ui/hover-card.tsx
```
'use client';

import * as React from 'react';
import { HoverCard as HoverCardPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground w-64 rounded-lg p-4 text-sm shadow-md ring-1 duration-100 z-50 origin-(--radix-hover-card-content-transform-origin) outline-hidden',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
```

### components/ui/card.tsx
```
import * as React from 'react';

import { cn } from '@/lib/utils';

function Card({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<'div'> & { size?: 'default' | 'sm' }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        'ring-foreground/10 bg-card text-card-foreground gap-6 overflow-hidden rounded-xl py-6 text-sm shadow-xs ring-1 has-[>img:first-child]:pt-0 data-[size=sm]:gap-4 data-[size=sm]:py-4 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'gap-1 rounded-t-xl px-6 group-data-[size=sm]/card:px-4 [.border-b]:pb-6 group-data-[size=sm]/card:[.border-b]:pb-4 group/card-header @container/card-header grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        'text-base leading-normal font-medium group-data-[size=sm]/card:text-sm',
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
```

### components/ui/carousel.tsx
```
'use client';

import * as React from 'react';
import useEmblaCarousel, { type UseEmblaCarouselType } from 'embla-carousel-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];

type CarouselProps = {
  opts?: CarouselOptions;
  plugins?: CarouselPlugin;
  orientation?: 'horizontal' | 'vertical';
  setApi?: (api: CarouselApi) => void;
};

type CarouselContextProps = {
  carouselRef: ReturnType<typeof useEmblaCarousel>[0];
  api: ReturnType<typeof useEmblaCarousel>[1];
  scrollPrev: () => void;
  scrollNext: () => void;
  canScrollPrev: boolean;
  canScrollNext: boolean;
} & CarouselProps;

const CarouselContext = React.createContext<CarouselContextProps | null>(null);

function useCarousel() {
  const context = React.useContext(CarouselContext);

  if (!context) {
    throw new Error('useCarousel must be used within a <Carousel />');
  }

  return context;
}

function Carousel({
  orientation = 'horizontal',
  opts,
  setApi,
  plugins,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & CarouselProps) {
  const [carouselRef, api] = useEmblaCarousel(
    {
      ...opts,
      axis: orientation === 'horizontal' ? 'x' : 'y',
    },
    plugins,
  );
  const [canScrollPrev, setCanScrollPrev] = React.useState(false);
  const [canScrollNext, setCanScrollNext] = React.useState(false);
```

### components/roundtable/index.tsx
```
'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  MicOff,
  Send,
  MessageSquare,
  Pause,
  Play,
  ChevronLeft,
  ChevronRight,
  Repeat,
  BookOpen,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CanvasToolbar } from '@/components/canvas/canvas-toolbar';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useI18n } from '@/lib/hooks/use-i18n';
import { toast } from 'sonner';
import { useSettingsStore, PLAYBACK_SPEEDS } from '@/lib/store/settings';
import { ProactiveCard } from '@/components/chat/proactive-card';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { DiscussionAction } from '@/lib/types/action';
import type { EngineMode, PlaybackView } from '@/lib/playback';
import type { Participant } from '@/lib/types/roundtable';

export interface DiscussionRequest {
  topic: string;
  prompt?: string;
  agentId?: string; // Agent ID to initiate discussion (default: 'default-1')
}

interface RoundtableProps {
  readonly mode?: 'playback' | 'autonomous';
  readonly initialParticipants?: Participant[];
  readonly playbackView?: PlaybackView; // Centralised derived state from Stage
  readonly currentSpeech?: string | null; // Live SSE speech (from StreamBuffer — discussion/QA)
  readonly lectureSpeech?: string | null; // Active lecture speech (from PlaybackEngine, full text)
  readonly idleText?: string | null; // Static idle text (first speech action)
  readonly playbackCompleted?: boolean; // True when engine finished all actions (show restart icon)
  readonly discussionRequest?: DiscussionAction | null;
  readonly engineMode?: EngineMode;
  readonly isStreaming?: boolean;
  readonly sessionType?: 'qa' | 'discussion';
  readonly speakingAgentId?: string | null;
  readonly speechProgress?: number | null; // StreamBuffer reveal progress (0–1) for auto-scroll
  readonly showEndFlash?: boolean;
  readonly endFlashSessionType?: 'qa' | 'discussion';
  readonly thinkingState?: { stage: string; agentId?: string } | null;
  readonly isCueUser?: boolean;
  readonly isTopicPending?: boolean;
  readonly onMessageSend?: (message: string) => void;
  readonly onDiscussionStart?: (request: DiscussionAction) => void;
  readonly onDiscussionSkip?: () => void;
  readonly onStopDiscussion?: () => void;
  readonly onInputActivate?: () => void;
```

### components/stage/scene-renderer.tsx
```
'use client';

import { useMemo } from 'react';
import type { Scene, StageMode } from '@/lib/types/stage';
import { SlideEditor as SlideRenderer } from '../slide-renderer/Editor';
import { QuizView } from '../scene-renderers/quiz-view';
import { InteractiveRenderer } from '../scene-renderers/interactive-renderer';
import { PBLRenderer } from '../scene-renderers/pbl-renderer';

interface SceneRendererProps {
  readonly scene: Scene;
  readonly mode: StageMode;
}

export function SceneRenderer({ scene, mode }: SceneRendererProps) {
  const renderer = useMemo(() => {
    switch (scene.type) {
      case 'slide':
        if (scene.content.type !== 'slide') return <div>Invalid slide content</div>;
        return <SlideRenderer mode={mode} />;
      case 'quiz':
        if (scene.content.type !== 'quiz') return <div>Invalid quiz content</div>;
        return <QuizView key={scene.id} questions={scene.content.questions} sceneId={scene.id} />;
      case 'interactive':
        if (scene.content.type !== 'interactive') return <div>Invalid interactive content</div>;
        return <InteractiveRenderer content={scene.content} mode={mode} sceneId={scene.id} />;
      case 'pbl':
        if (scene.content.type !== 'pbl') return <div>Invalid PBL content</div>;
        return <PBLRenderer content={scene.content} mode={mode} sceneId={scene.id} />;
      default:
        return <div>Unknown scene type</div>;
    }
  }, [scene, mode]);

  return <div className="w-full h-full">{renderer}</div>;
}
```

### components/stage/scene-sidebar.tsx
```
'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  PanelLeftClose,
  PieChart,
  Cpu,
  MousePointer2,
  BookOpen,
  Globe,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThumbnailSlide } from '@/components/slide-renderer/components/ThumbnailSlide';
import { useStageStore, useCanvasStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { SceneType, SlideContent } from '@/lib/types/stage';
import { PENDING_SCENE_ID } from '@/lib/store/stage';

interface SceneSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect?: (sceneId: string) => void;
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
}

const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 170;
const MAX_WIDTH = 400;

export function SceneSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
  onRetryOutline,
}: SceneSidebarProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { scenes, currentSceneId, setCurrentSceneId, generatingOutlines, generationStatus } =
    useStageStore();
  const failedOutlines = useStageStore.use.failedOutlines();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  const [retryingOutlineId, setRetryingOutlineId] = useState<string | null>(null);

  const handleRetryOutline = async (outlineId: string) => {
    if (!onRetryOutline) return;
    setRetryingOutlineId(outlineId);
    try {
      await onRetryOutline(outlineId);
    } finally {
      setRetryingOutlineId(null);
    }
  };

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const isDraggingRef = useRef(false);
```

### components/settings/utils.ts
```
export function formatContextWindow(size?: number): string {
  if (!size) return '-';

  // For M: prefer decimal (use decimal for exact thousands)
  if (size >= 1000000) {
    if (size % 1000000 === 0) {
      return `${size / 1000000}M`;
    }
    return `${(size / 1000000).toFixed(1)}M`;
  }

  // For K: prefer decimal if divisible by 1000, otherwise use binary
  if (size >= 1000) {
    if (size % 1000 === 0) {
      return `${size / 1000}K`;
    }
    return `${Math.floor(size / 1024)}K`;
  }

  return size.toString();
}

export function getProviderTypeLabel(type: string, t: (key: string) => string): string {
  const translationKey = `settings.providerTypes.${type}`;
  const translated = t(translationKey);
  // If translation exists (not equal to key), use it; otherwise fallback to type
  return translated !== translationKey ? translated : type;
}
```

### components/settings/model-selector.tsx
```
'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Check,
  Search,
  Sparkles,
  Wrench,
  Zap,
  Box,
  Loader2,
  CheckCircle,
  XCircle,
  FileText,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderId } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { formatContextWindow } from './utils';

interface ModelSelectorProps {
  providerId: ProviderId;
  modelId: string;
  onModelChange: (providerId: ProviderId, modelId: string) => void;
  providersConfig: ProvidersConfig;
}

export function ModelSelector({
  providerId,
  modelId,
  onModelChange,
  providersConfig,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const [activeProvider, setActiveProvider] = useState<ProviderId>(providerId);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const selectedModelRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Helper function to get translated provider name
  const getProviderDisplayName = (pid: ProviderId, name: string) => {
    const translationKey = `settings.providerNames.${pid}`;
    const translated = t(translationKey);
    // If translation exists (not equal to key), use it; otherwise fallback to name
    return translated !== translationKey ? translated : name;
  };

  // Helper function for model count with proper plural form
  const getModelCountText = (count: number) => {
    const key = count === 1 ? 'settings.modelSingular' : 'settings.modelCount';
    return `${count} ${t(key)}`;
  };
```

### components/settings/agent-settings.tsx
```
'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertCircle, User, Users, Sparkles, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

interface Agent {
  id: string;
  name: string;
  avatar: string;
  role: string;
  priority: number;
  allowedActions: string[];
}

interface AgentSettingsProps {
  agents: Agent[];
  selectedAgentIds: string[];
  maxTurns: string;
  agentMode: 'preset' | 'auto';
  onToggleAgent: (agentId: string) => void;
  onMaxTurnsChange: (value: string) => void;
  onAgentModeChange: (mode: 'preset' | 'auto') => void;
}

export function AgentSettings({
  agents,
  selectedAgentIds,
  maxTurns,
  agentMode,
  onToggleAgent,
  onMaxTurnsChange,
  onAgentModeChange,
}: AgentSettingsProps) {
  const { t } = useI18n();

  const getAgentName = (agent: Agent) => {
    const key = `settings.agentNames.${agent.id}`;
    const translated = t(key);
    return translated !== key ? translated : agent.name;
  };

  const getAgentRole = (agent: Agent) => {
    const key = `settings.agentRoles.${agent.role}`;
    const translated = t(key);
    return translated !== key ? translated : agent.role;
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="space-y-4">
        {/* Mode Toggle */}
        <div className="space-y-2">
          <Label>{t('settings.agentMode')}</Label>
          <div className="inline-flex rounded-lg border bg-muted/30 p-0.5">
            <button
```

### components/settings/general-settings.tsx
```
'use client';

import { useState, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { clearDatabase } from '@/lib/utils/database';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';

const log = createLogger('GeneralSettings');

export function GeneralSettings() {
  const { t } = useI18n();

  // Clear cache state
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [clearing, setClearing] = useState(false);

  const confirmPhrase = t('settings.clearCacheConfirmPhrase');
  const isConfirmValid = confirmInput === confirmPhrase;

  const handleClearCache = useCallback(async () => {
    if (!isConfirmValid) return;
    setClearing(true);
    try {
      // 1. Clear IndexedDB
      await clearDatabase();
      // 2. Clear localStorage
      localStorage.clear();
      // 3. Clear sessionStorage
      sessionStorage.clear();

      toast.success(t('settings.clearCacheSuccess'));

      // Reload page after a short delay
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      log.error('Failed to clear cache:', error);
      toast.error(t('settings.clearCacheFailed'));
      setClearing(false);
    }
  }, [isConfirmValid, t]);

  const clearCacheItems =
    t('settings.clearCacheConfirmItems').split('、').length > 1
```

### components/settings/pdf-settings.tsx
```
'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { CheckCircle2, Eye, EyeOff, Loader2, Zap, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Get display label for feature
 */
function getFeatureLabel(feature: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    text: t('settings.featureText'),
    images: t('settings.featureImages'),
    tables: t('settings.featureTables'),
    formulas: t('settings.featureFormulas'),
    'layout-analysis': t('settings.featureLayoutAnalysis'),
    metadata: t('settings.featureMetadata'),
  };
  return labels[feature] || feature;
}

interface PDFSettingsProps {
  selectedProviderId: PDFProviderId;
}

export function PDFSettings({ selectedProviderId }: PDFSettingsProps) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const pdfProvidersConfig = useSettingsStore((state) => state.pdfProvidersConfig);
  const setPDFProviderConfig = useSettingsStore((state) => state.setPDFProviderConfig);

  const pdfProvider = PDF_PROVIDERS[selectedProviderId];
  const isServerConfigured = !!pdfProvidersConfig[selectedProviderId]?.isServerConfigured;
  const providerConfig = pdfProvidersConfig[selectedProviderId];
  const hasBaseUrl = !!providerConfig?.baseUrl;
  const needsRemoteConfig = selectedProviderId === 'mineru';

  // Reset state when provider changes
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setShowApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
  }

  const handleTestConnection = async () => {
    const baseUrl = providerConfig?.baseUrl;
    if (!baseUrl) return;
```

### components/settings/index.tsx
```
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  X,
  Trash2,
  Box,
  Settings,
  CheckCircle2,
  XCircle,
  FileText,
  Image as ImageIcon,
  Film,
  Search,
  Volume2,
  Mic,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { toast } from 'sonner';
import { type ProviderId } from '@/lib/ai/providers';
import { PROVIDERS } from '@/lib/ai/providers';
import { cn } from '@/lib/utils';
import { getProviderTypeLabel } from './utils';
import { ProviderList } from './provider-list';
import { ProviderConfigPanel } from './provider-config-panel';
import { PDFSettings } from './pdf-settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { ImageSettings } from './image-settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type { ImageProviderId } from '@/lib/media/types';
import { VideoSettings } from './video-settings';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type { VideoProviderId } from '@/lib/media/types';
import { TTSSettings } from './tts-settings';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import { ASRSettings } from './asr-settings';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import type { ASRProviderId } from '@/lib/audio/types';
import { WebSearchSettings } from './web-search-settings';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { GeneralSettings } from './general-settings';
import { ModelEditDialog } from './model-edit-dialog';
import { AddProviderDialog, type NewProviderData } from './add-provider-dialog';
import type { SettingsSection, EditingModel } from '@/lib/types/settings';
```

### components/settings/tts-settings.tsx
```
'use client';

import { useState, useRef, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { TTS_PROVIDERS, DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import { Volume2, Loader2, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('TTSSettings');

interface TTSSettingsProps {
  selectedProviderId: TTSProviderId;
}

export function TTSSettings({ selectedProviderId }: TTSSettingsProps) {
  const { t } = useI18n();

  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const setTTSProviderConfig = useSettingsStore((state) => state.setTTSProviderConfig);
  const activeProviderId = useSettingsStore((state) => state.ttsProviderId);

  // When testing a non-active provider, use that provider's default voice
  // instead of the active provider's voice (which may be incompatible)
  const effectiveVoice =
    selectedProviderId === activeProviderId
      ? ttsVoice
      : DEFAULT_TTS_VOICES[selectedProviderId] || 'default';

  const ttsProvider = TTS_PROVIDERS[selectedProviderId] ?? TTS_PROVIDERS['openai-tts'];
  const isServerConfigured = !!ttsProvidersConfig[selectedProviderId]?.isServerConfigured;

  const [showApiKey, setShowApiKey] = useState(false);
  const [testingTTS, setTestingTTS] = useState(false);
  const [testText, setTestText] = useState(t('settings.ttsTestTextDefault'));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);

  // Update test text when language changes
  useEffect(() => {
    setTestText(t('settings.ttsTestTextDefault'));
  }, [t]);

  // Reset state when provider changes
  useEffect(() => {
    setShowApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
  }, [selectedProviderId]);

  const handleTestTTS = async () => {
    if (!testText.trim()) return;
```

### components/settings/provider-list.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { Box, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderId, ProviderConfig } from '@/lib/ai/providers';

interface ProviderWithServerInfo extends ProviderConfig {
  isServerConfigured?: boolean;
}

interface ProviderListProps {
  providers: ProviderWithServerInfo[];
  selectedProviderId: ProviderId;
  onSelect: (providerId: ProviderId) => void;
  onAddProvider: () => void;
  width?: number;
}

export function ProviderList({
  providers,
  selectedProviderId,
  onSelect,
  onAddProvider,
  width,
}: ProviderListProps) {
  const { t } = useI18n();

  // Helper function to get translated provider name
  const getProviderDisplayName = (provider: ProviderConfig) => {
    const translationKey = `settings.providerNames.${provider.id}`;
    const translated = t(translationKey);
    // If translation exists (not equal to key), use it; otherwise fallback to provider.name
    return translated !== translationKey ? translated : provider.name;
  };

  return (
    <div className="flex-shrink-0 bg-background flex flex-col" style={{ width: width ?? 192 }}>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {providers.map((provider) => (
          <button
            key={provider.id}
            onClick={() => onSelect(provider.id)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all border text-left',
              selectedProviderId === provider.id
                ? 'bg-primary/5 border-primary/50 shadow-sm'
                : 'border-transparent hover:bg-muted/50',
            )}
          >
            {provider.icon ? (
              <img
                src={provider.icon}
                alt={getProviderDisplayName(provider)}
                className="w-5 h-5 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
```

### components/settings/asr-settings.tsx
```
'use client';

import { useState, useRef } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import type { ASRProviderId } from '@/lib/audio/types';
import { Mic, MicOff, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('ASRSettings');

interface ASRSettingsProps {
  selectedProviderId: ASRProviderId;
}

export function ASRSettings({ selectedProviderId }: ASRSettingsProps) {
  const { t } = useI18n();

  const asrLanguage = useSettingsStore((state) => state.asrLanguage);
  const asrProvidersConfig = useSettingsStore((state) => state.asrProvidersConfig);
  const setASRProviderConfig = useSettingsStore((state) => state.setASRProviderConfig);

  const asrProvider = ASR_PROVIDERS[selectedProviderId] ?? ASR_PROVIDERS['openai-whisper'];
  const isServerConfigured = !!asrProvidersConfig[selectedProviderId]?.isServerConfigured;

  const [showApiKey, setShowApiKey] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [asrResult, setASRResult] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // Reset state when provider changes (derived state pattern)
  const [prevProviderId, setPrevProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevProviderId) {
    setPrevProviderId(selectedProviderId);
    setShowApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
    setASRResult('');
  }

  const handleToggleASRRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
    } else {
      setASRResult('');
      setTestStatus('testing');
      setTestMessage('');

      if (selectedProviderId === 'browser-native') {
        const SpeechRecognitionCtor =
```

### components/settings/video-settings.tsx
```
'use client';

import { useState, useCallback, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Zap,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VideoProviderId } from '@/lib/media/types';

interface VideoSettingsProps {
  selectedProviderId: VideoProviderId;
}

export function VideoSettings({ selectedProviderId }: VideoSettingsProps) {
  const { t } = useI18n();

  const videoModelId = useSettingsStore((state) => state.videoModelId);
  const videoProvidersConfig = useSettingsStore((state) => state.videoProvidersConfig);
  const setVideoProviderConfig = useSettingsStore((state) => state.setVideoProviderConfig);

  const [showApiKey, setShowApiKey] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Model dialog state
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState({ id: '', name: '' });

  // Reset test state when provider changes (derived state pattern)
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setTestStatus('idle');
    setTestMessage('');
  }

  const currentConfig = videoProvidersConfig[selectedProviderId];
  const currentProvider = VIDEO_PROVIDERS[selectedProviderId];
  const builtInModels = currentProvider?.models || [];
  const customModels = useMemo(
    () => currentConfig?.customModels || [],
    [currentConfig?.customModels],
  );
```

### components/settings/model-edit-dialog.tsx
```
'use client';

import { useState, useCallback, useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Sparkles, Wrench, Zap, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { EditingModel } from '@/lib/types/settings';
import type { ProviderId } from '@/lib/ai/providers';
import { cn } from '@/lib/utils';

interface ModelEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingModel: EditingModel | null;
  setEditingModel: (model: EditingModel | null) => void;
  onSave: () => void;
  onAutoSave?: () => void; // Auto-save on blur
  providerId: ProviderId;
  apiKey: string;
  baseUrl?: string;
  providerType?: string;
  requiresApiKey?: boolean;
}

export function ModelEditDialog({
  open,
  onOpenChange,
  editingModel,
  setEditingModel,
  onSave,
  onAutoSave,
  providerId,
  apiKey,
  baseUrl,
  providerType,
  requiresApiKey,
}: ModelEditDialogProps) {
  const { t } = useI18n();
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Reset test status when dialog closes
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset state when dialog closes
      setTestStatus('idle');

      setTestMessage('');
    }
  }, [open]);

  const handleClose = () => {
    onOpenChange(false);
    setEditingModel(null);
  };

```

### components/settings/image-settings.tsx
```
'use client';

import { useState, useCallback, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Zap,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ImageProviderId } from '@/lib/media/types';

interface ImageSettingsProps {
  selectedProviderId: ImageProviderId;
}

export function ImageSettings({ selectedProviderId }: ImageSettingsProps) {
  const { t } = useI18n();

  const imageModelId = useSettingsStore((state) => state.imageModelId);
  const imageProvidersConfig = useSettingsStore((state) => state.imageProvidersConfig);
  const _setImageModelId = useSettingsStore((state) => state.setImageModelId);
  const setImageProviderConfig = useSettingsStore((state) => state.setImageProviderConfig);

  const [showApiKey, setShowApiKey] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Model dialog state
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState({ id: '', name: '' });

  // Reset test state when provider changes (derived state pattern)
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setTestStatus('idle');
    setTestMessage('');
  }

  const currentConfig = imageProvidersConfig[selectedProviderId];
  const currentProvider = IMAGE_PROVIDERS[selectedProviderId];
  const builtInModels = currentProvider?.models || [];
  const customModels = useMemo(
    () => currentConfig?.customModels || [],
    [currentConfig?.customModels],
```

### components/settings/provider-config-panel.tsx
```
'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  RotateCcw,
  Plus,
  Zap,
  Settings2,
  Trash2,
  Sparkles,
  Wrench,
  FileText,
  Send,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderConfig } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { formatContextWindow } from './utils';
import { cn } from '@/lib/utils';

interface ProviderConfigPanelProps {
  provider: ProviderConfig;
  initialApiKey: string;
  initialBaseUrl: string;
  initialRequiresApiKey: boolean;
  providersConfig: ProvidersConfig;
  onConfigChange: (apiKey: string, baseUrl: string, requiresApiKey: boolean) => void;
  onSave: () => void; // Auto-save on blur
  onEditModel: (index: number) => void;
  onDeleteModel: (index: number) => void;
  onAddModel: () => void;
  onResetToDefault?: () => void; // Reset provider to default configuration
  isBuiltIn: boolean; // To determine if reset button should be shown
}

export function ProviderConfigPanel({
  provider,
  initialApiKey,
  initialBaseUrl,
  initialRequiresApiKey,
  providersConfig,
```

### components/settings/audio-settings.tsx
```
'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import {
  TTS_PROVIDERS,
  getTTSVoices,
  ASR_PROVIDERS,
  getASRSupportedLanguages,
} from '@/lib/audio/constants';
import type { TTSProviderId, ASRProviderId } from '@/lib/audio/types';
import { Volume2, Mic, MicOff, Loader2, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import azureVoicesData from '@/lib/audio/azure.json';
import { createLogger } from '@/lib/logger';

const log = createLogger('AudioSettings');

/**
 * Get provider display name with i18n
 */
function getTTSProviderName(providerId: TTSProviderId, t: (key: string) => string): string {
  const names: Record<TTSProviderId, string> = {
    'openai-tts': t('settings.providerOpenAITTS'),
    'azure-tts': t('settings.providerAzureTTS'),
    'glm-tts': t('settings.providerGLMTTS'),
    'qwen-tts': t('settings.providerQwenTTS'),
    'browser-native-tts': t('settings.providerBrowserNativeTTS'),
  };
  return names[providerId];
}

function getASRProviderName(providerId: ASRProviderId, t: (key: string) => string): string {
  const names: Record<ASRProviderId, string> = {
    'openai-whisper': t('settings.providerOpenAIWhisper'),
    'browser-native': t('settings.providerBrowserNative'),
    'qwen-asr': t('settings.providerQwenASR'),
  };
  return names[providerId];
}

function getLanguageName(code: string, t: (key: string) => string): string {
  const key = `settings.lang_${code}`;
  const translated = t(key);
  // If translation key not found, return the code itself
  return translated === key ? code : translated;
}
```

### components/settings/add-provider-dialog.tsx
```
'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

export interface NewProviderData {
  name: string;
  type: 'openai' | 'anthropic' | 'google';
  baseUrl: string;
  icon: string;
  requiresApiKey: boolean;
}

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (provider: NewProviderData) => void;
}

export function AddProviderDialog({ open, onOpenChange, onAdd }: AddProviderDialogProps) {
  const { t } = useI18n();

  // Internal state
  const [name, setName] = useState('');
  const [type, setType] = useState<'openai' | 'anthropic' | 'google'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [requiresApiKey, setRequiresApiKey] = useState(true);

  // Reset form when dialog closes (derived state pattern)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName('');
      setType('openai');
      setBaseUrl('');
      setIcon('');
      setRequiresApiKey(true);
    }
  }

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleAdd = () => {
    onAdd({
      name,
      type,
      baseUrl,
      icon,
      requiresApiKey,
```

### components/settings/web-search-settings.tsx
```
'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { Eye, EyeOff } from 'lucide-react';

interface WebSearchSettingsProps {
  selectedProviderId: WebSearchProviderId;
}

export function WebSearchSettings({ selectedProviderId }: WebSearchSettingsProps) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);

  const webSearchProvidersConfig = useSettingsStore((state) => state.webSearchProvidersConfig);
  const setWebSearchProviderConfig = useSettingsStore((state) => state.setWebSearchProviderConfig);

  const provider = WEB_SEARCH_PROVIDERS[selectedProviderId];
  const isServerConfigured = !!webSearchProvidersConfig[selectedProviderId]?.isServerConfigured;

  // Reset showApiKey when provider changes (derived state pattern)
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setShowApiKey(false);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* API Key + Base URL Configuration */}
      {(provider.requiresApiKey || isServerConfigured) && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.webSearchApiKey')}</Label>
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  placeholder={
                    isServerConfigured ? t('settings.optionalOverride') : t('settings.enterApiKey')
                  }
                  value={webSearchProvidersConfig[selectedProviderId]?.apiKey || ''}
                  onChange={(e) =>
                    setWebSearchProviderConfig(selectedProviderId, {
                      apiKey: e.target.value,
                    })
                  }
                  className="font-mono text-sm pr-10"
```

### components/chat/lecture-notes-view.tsx
```
'use client';

import { useEffect, useRef } from 'react';
import { BookOpen, MessageSquare, Flashlight, MousePointer2, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LectureNoteEntry } from '@/lib/types/chat';

const ACTION_ICON_ONLY: Record<string, { Icon: typeof Flashlight; style: string }> = {
  spotlight: {
    Icon: Flashlight,
    style:
      'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300',
  },
  laser: {
    Icon: MousePointer2,
    style:
      'bg-red-50 dark:bg-red-500/15 border-red-300/40 dark:border-red-500/30 text-red-600 dark:text-red-300',
  },
  play_video: {
    Icon: Play,
    style:
      'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300',
  },
};

interface LectureNotesViewProps {
  notes: LectureNoteEntry[];
  currentSceneId?: string | null;
}

export function LectureNotesView({ notes, currentSceneId }: LectureNotesViewProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the current scene note
  useEffect(() => {
    if (!currentSceneId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-scene-id="${currentSceneId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentSceneId]);

  // Empty state
  if (notes.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-6">
        <div className="w-12 h-12 bg-purple-50 dark:bg-purple-900/20 rounded-2xl flex items-center justify-center mb-3 text-purple-300 dark:text-purple-600 ring-1 ring-purple-100 dark:ring-purple-800/30">
          <BookOpen className="w-6 h-6" />
        </div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {t('chat.lectureNotes.empty')}
        </p>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
          {t('chat.lectureNotes.emptyHint')}
        </p>
      </div>
    );
  }
```

### components/chat/proactive-card.tsx
```
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Play, Pause, X } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { DiscussionAction } from '@/lib/types/action';

interface ProactiveCardProps {
  action: DiscussionAction;
  mode: 'playback' | 'paused' | 'autonomous';
  /** Ref to the anchor element the card points to (avatar, etc.) */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Where the card prefers to align relative to the anchor */
  align?: 'left' | 'right';
  agentName?: string;
  agentAvatar?: string;
  agentColor?: string;
  onSkip: () => void;
  onListen: () => void;
  onTogglePause: () => void;
}

const CARD_WIDTH = 256; // w-64
const VIEWPORT_PAD = 12;

/**
 * 主动讨论卡片组件
 *
 * 通过 React Portal 渲染到 document.body，使用 fixed 定位，
 * 不受父级 overflow/z-index stacking context 影响。
 */
export const ProactiveCard = ({
  action,
  mode,
  anchorRef,
  align = 'right',
  agentName,
  agentAvatar,
  agentColor,
  onSkip,
  onListen,
  onTogglePause,
}: ProactiveCardProps) => {
  const { t } = useI18n();
  const [progress, setProgress] = useState(100);
  const skippedRef = useRef(false);
  const isPaused = mode === 'paused';

  // Computed position state
  const [pos, setPos] = useState<{
    left: number;
    bottom: number;
    tailOffset: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
```

### components/chat/use-chat-sessions.ts
```
'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  ChatSession,
  SessionType,
  SessionStatus,
  ChatMessageMetadata,
  DirectorState,
} from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action, SpotlightAction, DiscussionAction } from '@/lib/types/action';
import type { UIMessage } from 'ai';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { USER_AVATAR } from '@/lib/types/roundtable';
import { processSSEStream } from './process-sse-stream';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import type { AgentStartItem, ActionItem } from '@/lib/buffer/stream-buffer';
import { ActionEngine } from '@/lib/action/engine';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';

const log = createLogger('ChatSessions');

interface UseChatSessionsOptions {
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onActiveBubble?: (messageId: string | null) => void;
  /** Called when a QA/Discussion session completes naturally (director end). */
  onStopSession?: () => void;
}

export function useChatSessions(options: UseChatSessionsOptions = {}) {
  const onLiveSpeechRef = useRef(options.onLiveSpeech);
  const onSpeechProgressRef = useRef(options.onSpeechProgress);
  const onThinkingRef = useRef(options.onThinking);
  const onCueUserRef = useRef(options.onCueUser);
  const onActiveBubbleRef = useRef(options.onActiveBubble);
  const onStopSessionRef = useRef(options.onStopSession);
  useEffect(() => {
    onLiveSpeechRef.current = options.onLiveSpeech;
    onSpeechProgressRef.current = options.onSpeechProgress;
    onThinkingRef.current = options.onThinking;
    onCueUserRef.current = options.onCueUser;
    onActiveBubbleRef.current = options.onActiveBubble;
    onStopSessionRef.current = options.onStopSession;
  }, [
    options.onLiveSpeech,
    options.onSpeechProgress,
    options.onThinking,
    options.onCueUser,
    options.onActiveBubble,
```

### components/chat/chat-session.tsx
```
'use client';

import { useEffect, useRef, useCallback, memo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { ChatSession, ChatMessageMetadata } from '@/lib/types/chat';
import type { UIMessage } from 'ai';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { CircleStop } from 'lucide-react';
import { InlineActionTag } from './inline-action-tag';
import { useUserProfileStore } from '@/lib/store/user-profile';

/** Extended message part type covering standard + custom action parts */
interface MessagePart {
  type: string;
  text?: string;
  _partId?: string;
  actionName?: string;
  state?: string;
}

interface ChatSessionProps {
  readonly session: ChatSession;
  readonly isActive: boolean;
  readonly isStreaming?: boolean;
  readonly activeBubbleId?: string | null;
  readonly onEndSession?: (sessionId: string) => void;
}

const AVATARS = {
  teacher: '/avatars/teacher.png',
  user: '/avatars/user.png',
};

/** Render avatar as <img> for URLs or as emoji text span */
function AvatarDisplay({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const isUrl = src.startsWith('http') || src.startsWith('data:') || src.startsWith('/');
  if (isUrl) {
    return (
      <img src={src} alt={alt || ''} className={cn('w-full h-full object-cover', className)} />
    );
  }
  return (
    <span
      className={cn(
        'flex items-center justify-center w-full h-full select-none text-xs',
        className,
      )}
    >
      {src}
    </span>
  );
}

/**
 * MessageBubble — renders one message as a single chat bubble.
 *
 * Text is already paced by the StreamBuffer (30ms / 1 char) before it reaches
 * React state. No UI-layer animation is needed — we render parts directly.
 * Action badges only appear once the buffer's tick loop reaches them (after
```

### components/chat/process-sse-stream.ts
```
import type { StatelessEvent } from '@/lib/types/chat';
import type { StreamBuffer } from '@/lib/buffer/stream-buffer';
import { createLogger } from '@/lib/logger';

const log = createLogger('SSEStream');

/**
 * Thin SSE parser — reads the /api/chat response stream and pushes
 * typed events into a StreamBuffer. All pacing, state management,
 * and UI updates are handled by the buffer's tick loop and callbacks.
 */
export async function processSSEStream(
  response: Response,
  sessionId: string,
  buffer: StreamBuffer,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let sseBuffer = '';
  let currentMessageId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      sseBuffer += chunk;

      // Process complete SSE events (split on double newline)
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop() || '';

      for (const eventStr of events) {
        const line = eventStr.trim();
        if (!line.startsWith('data: ')) continue;

        let sseError: Error | null = null;

        try {
          const event: StatelessEvent = JSON.parse(line.slice(6));

          switch (event.type) {
            case 'agent_start': {
              const { messageId, agentId, agentName, agentAvatar, agentColor } = event.data;
              currentMessageId = messageId;
              buffer.pushAgentStart({
                messageId,
                agentId,
                agentName,
                avatar: agentAvatar,
                color: agentColor,
              });
              break;
            }
```

### components/chat/inline-action-tag.tsx
```
'use client';

import { cn } from '@/lib/utils';
import {
  Flashlight,
  MousePointer2,
  Type,
  Shapes,
  Eraser,
  PanelLeftOpen,
  PanelLeftClose,
  MessageSquare,
  Zap,
  Loader2,
  BarChart3,
  Sigma,
  Table2,
  PenLine,
  Trash2,
  Play,
  Minus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface InlineActionTagProps {
  actionName: string;
  state: string;
}

// ── Style tokens ──────────────────────────────────────────────

const WB_STYLE =
  'bg-violet-50 dark:bg-violet-500/15 border-violet-300/40 dark:border-violet-500/30 text-violet-600 dark:text-violet-300';
const WB_ACCENT = 'bg-violet-500 dark:bg-violet-400';

const SPOTLIGHT_STYLE =
  'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300';
const LASER_STYLE =
  'bg-red-50 dark:bg-red-500/15 border-red-300/40 dark:border-red-500/30 text-red-600 dark:text-red-300';
const DISCUSS_STYLE =
  'bg-amber-50 dark:bg-amber-500/15 border-amber-300/40 dark:border-amber-500/30 text-amber-700 dark:text-amber-300';
const DEFAULT_STYLE =
  'bg-gray-50 dark:bg-gray-500/15 border-gray-300/40 dark:border-gray-500/30 text-gray-600 dark:text-gray-300';

// ── Action config ─────────────────────────────────────────────

interface ActionCfg {
  label: string;
  Icon: LucideIcon;
  style: string;
  /** Whiteboard family — gets the pen-line accent indicator */
  wb?: boolean;
}

const ACTION_CONFIG: Record<string, ActionCfg> = {
  // Slide effects
  spotlight: { label: 'Spotlight', Icon: Flashlight, style: SPOTLIGHT_STYLE },
  laser: { label: 'Laser', Icon: MousePointer2, style: LASER_STYLE },
  play_video: { label: 'Play', Icon: Play, style: SPOTLIGHT_STYLE },

```

### components/chat/session-list.tsx
```
'use client';

import type { ChatSession, SessionStatus } from '@/lib/types/chat';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ChevronDown, Circle, CheckCircle, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ChatSessionComponent } from './chat-session';

interface SessionListProps {
  sessions: ChatSession[];
  expandedSessionIds: Set<string>;
  isStreaming: boolean;
  activeBubbleId?: string | null;
  onToggleExpand: (sessionId: string) => void;
  onEndSession: (sessionId: string) => Promise<void>;
}

const sessionBadgeStyles = {
  qa: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  discussion: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  lecture: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
};

// Labels are provided via i18n in the component

function getStatusIcon(status: SessionStatus) {
  switch (status) {
    case 'active':
      return <Circle className="size-2.5 fill-green-500 text-green-500" />;
    case 'interrupted':
      return <Clock className="size-2.5 text-yellow-500" />;
    case 'completed':
      return <CheckCircle className="size-2.5 text-gray-400" />;
    case 'idle':
    default:
      return <Circle className="size-2.5 text-gray-300" />;
  }
}

export function SessionList({
  sessions,
  expandedSessionIds,
  isStreaming,
  activeBubbleId,
  onToggleExpand,
  onEndSession,
}: SessionListProps) {
  const { t } = useI18n();
  return (
    <>
      {sessions.map((session) => {
        const isExpanded = expandedSessionIds.has(session.id);
        const isActive = session.status === 'active';
        const dotColor =
          session.type === 'lecture'
            ? 'bg-purple-500'
            : session.type === 'qa'
              ? 'bg-blue-500'
              : 'bg-amber-500';
```

### components/chat/chat-area.tsx
```
'use client';

import { useImperativeHandle, forwardRef, useRef, useCallback, useState, useMemo } from 'react';
import type { SessionType } from '@/lib/types/chat';
import type { LectureNoteEntry } from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action, SpeechAction, DiscussionAction } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { PanelRightClose, BookOpen, MessageSquare } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useChatSessions } from './use-chat-sessions';
import { SessionList } from './session-list';
import { LectureNotesView } from './lecture-notes-view';

interface ChatAreaProps {
  className?: string;
  width?: number;
  onWidthChange?: (width: number) => void;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  activeBubbleId?: string | null;
  onActiveBubble?: (messageId: string | null) => void;
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onStopSession?: () => void;
  currentSceneId?: string | null;
}

export interface ChatAreaRef {
  createSession: (type: SessionType, title: string) => Promise<string>;
  endSession: (sessionId: string) => Promise<void>;
  endActiveSession: () => Promise<void>;
  softPauseActiveSession: () => Promise<void>;
  resumeActiveSession: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  startDiscussion: (request: DiscussionRequest) => Promise<void>;
  startLecture: (sceneId: string) => Promise<string>;
  addLectureMessage: (sessionId: string, action: Action, actionIndex: number) => void;
  getIsStreaming: () => boolean;
  getActiveSessionType: () => string | null;
  getLectureMessageId: (sessionId: string) => string | null;
  pauseBuffer: (sessionId: string) => void;
  resumeBuffer: (sessionId: string) => void;
  switchToTab: (tab: 'lecture' | 'chat') => void;
}

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(
  (
    {
      className,
      width = DEFAULT_WIDTH,
      onWidthChange,
```

### components/canvas/canvas-area.tsx
```
'use client';

import { useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { Whiteboard } from '@/components/whiteboard';
import { CanvasToolbar } from '@/components/canvas/canvas-toolbar';
import type { CanvasToolbarProps } from '@/components/canvas/canvas-toolbar';
import type { Scene, StageMode } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';

interface CanvasAreaProps extends CanvasToolbarProps {
  readonly currentScene: Scene | null;
  readonly mode: StageMode;
  readonly hideToolbar?: boolean;
  readonly isPendingScene?: boolean;
  readonly isGenerationFailed?: boolean;
  readonly onRetryGeneration?: () => void;
}

export function CanvasArea({
  currentScene,
  currentSceneIndex,
  scenesCount,
  mode,
  engineState,
  isLiveSession,
  whiteboardOpen,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onPlayPause,
  onWhiteboardClose,
  showStopDiscussion,
  onStopDiscussion,
  hideToolbar,
  isPendingScene,
  isGenerationFailed,
  onRetryGeneration,
}: CanvasAreaProps) {
  const { t } = useI18n();
  const showControls = mode === 'playback' && !whiteboardOpen;
  const showPlayHint =
    showControls &&
    engineState !== 'playing' &&
    currentScene?.type === 'slide' &&
    !isLiveSession &&
    !isPendingScene;

  const handleSlideClick = useCallback(
    (e: React.MouseEvent) => {
      if (!showControls || isLiveSession || currentScene?.type !== 'slide') return;
      // Don't trigger page play/pause when clicking inside a video element's visual area.
      // Video elements may be visually covered by other slide elements (e.g. text),
```

### components/canvas/canvas-toolbar.tsx
```
'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  PencilLine,
  LayoutList,
  MessageSquare,
  Volume1,
  Volume2,
  VolumeX,
  Repeat,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface CanvasToolbarProps {
  readonly currentSceneIndex: number;
  readonly scenesCount: number;
  readonly engineState: 'idle' | 'playing' | 'paused';
  readonly isLiveSession?: boolean;
  readonly whiteboardOpen: boolean;
  readonly sidebarCollapsed?: boolean;
  readonly chatCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
  readonly onToggleChat?: () => void;
  readonly onPrevSlide: () => void;
  readonly onNextSlide: () => void;
  readonly onPlayPause: () => void;
  readonly onWhiteboardClose: () => void;
  readonly showStopDiscussion?: boolean;
  readonly onStopDiscussion?: () => void;
  readonly className?: string;
  // Audio/playback controls
  readonly ttsEnabled?: boolean;
  readonly ttsMuted?: boolean;
  readonly ttsVolume?: number;
  readonly onToggleMute?: () => void;
  readonly onVolumeChange?: (volume: number) => void;
  readonly autoPlayLecture?: boolean;
  readonly onToggleAutoPlay?: () => void;
  readonly playbackSpeed?: number;
  readonly onCycleSpeed?: () => void;
}

/* Compact control button */
const ctrlBtn = cn(
  'relative w-7 h-7 rounded-md flex items-center justify-center',
  'transition-all duration-150 outline-none cursor-pointer',
  'hover:bg-gray-500/[0.08] dark:hover:bg-gray-400/[0.08] active:scale-90',
);

/* Subtle separator */
function CtrlDivider() {
  return <div className="w-px h-3 bg-gray-200/80 dark:bg-gray-700/60 mx-0.5 shrink-0" />;
```

### components/scene-renderers/interactive-renderer.tsx
```
'use client';

import { useMemo } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function InteractiveRenderer({ content, mode: _mode, sceneId }: InteractiveRendererProps) {
  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  return (
    <div className="w-full h-full relative">
      <iframe
        srcDoc={patchedHtml}
        src={patchedHtml ? undefined : content.url}
        className="absolute inset-0 w-full h-full border-0"
        title={`Interactive Scene ${sceneId}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Fixes:
 * - min-h-screen / h-screen → use 100% of iframe viewport
 * - Ensure html/body fill the iframe with no overflow issues
 * - Canvas elements use container sizing instead of viewport
 */
function patchHtmlForIframe(html: string): string {
  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }
</style>`;

  // Insert right after <head> or at the start of the document
  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
    return html.substring(0, insertPos) + '\n' + iframeCss + html.substring(insertPos);
  }

```

### components/scene-renderers/quiz-view.tsx
```
'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  PieChart,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ChevronRight,
  Check,
  BookOpenText,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { createLogger } from '@/lib/logger';

const log = createLogger('QuizView');
import type { QuizQuestion } from '@/lib/types/stage';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = 'not_started' | 'answering' | 'grading' | 'reviewing';

interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect';
  earned: number;
  aiComment?: string;
}

interface QuizViewProps {
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === 'short_answer' || (!q.hasAnswer && (!q.answer || q.answer.length === 0));
}

```

### components/scene-renderers/quiz-renderer.tsx
```
'use client';

import { useState } from 'react';
import type { QuizContent } from '@/lib/types/stage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface QuizRendererProps {
  readonly content: QuizContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function QuizRenderer({ content, mode, sceneId: _sceneId }: QuizRendererProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const handleAnswerChange = (questionId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
  };

  return (
    <div className="w-full h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold">Quiz</h1>
        {content.questions.map((question) => (
          <Card key={question.id}>
            <CardHeader>
              <CardTitle>{question.question}</CardTitle>
            </CardHeader>
            <CardContent>
              {question.type === 'single' && question.options && (
                <div className="space-y-2">
                  {question.options.map((option, optIndex) => {
                    // Normalize: options may be QuizOption objects or plain strings from AI
                    const optionValue = typeof option === 'string' ? option : option.value;
                    const optionLabel = typeof option === 'string' ? option : option.label;
                    const letterPrefix = String.fromCharCode(65 + optIndex); // A, B, C, D...

                    return (
                      <label
                        key={`${question.id}-opt-${optIndex}`}
                        className={cn(
                          'flex items-center space-x-2 p-2 rounded cursor-pointer hover:bg-muted',
                          answers[question.id] === (optionValue || letterPrefix) && 'bg-muted',
                        )}
                      >
                        <input
                          type="radio"
                          name={question.id}
                          value={optionValue || letterPrefix}
                          checked={answers[question.id] === (optionValue || letterPrefix)}
                          onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                          className="size-4"
                        />
                        <span>
                          {letterPrefix}. {optionLabel}
                        </span>
                      </label>
                    );
```

### components/scene-renderers/pbl-renderer.tsx
```
'use client';

import { useCallback } from 'react';
import type { PBLContent } from '@/lib/types/stage';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import { useStageStore } from '@/lib/store/stage';
import { PBLRoleSelection } from './pbl/role-selection';
import { PBLWorkspace } from './pbl/workspace';
import { useI18n } from '@/lib/hooks/use-i18n';

interface PBLRendererProps {
  readonly content: PBLContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function PBLRenderer({ content, mode: _mode, sceneId }: PBLRendererProps) {
  const { t } = useI18n();

  const { projectConfig } = content;
  const selectedRole = projectConfig?.selectedRole ?? null;

  const updateConfig = useCallback(
    (updatedConfig: PBLProjectConfig) => {
      const scenes = useStageStore.getState().scenes;
      const updatedScenes = scenes.map((scene) =>
        scene.id === sceneId
          ? {
              ...scene,
              content: { type: 'pbl' as const, projectConfig: updatedConfig },
            }
          : scene,
      );
      useStageStore.setState({ scenes: updatedScenes });
    },
    [sceneId],
  );

  const handleSelectRole = useCallback(
    (roleName: string) => {
      if (!projectConfig) return;
      const newConfig = { ...projectConfig, selectedRole: roleName };

      // Add Question Agent welcome message if chat is empty and active issue has questions
      const activeIssue = newConfig.issueboard.issues.find((i) => i.is_active);
      if (activeIssue?.generated_questions && newConfig.chat.messages.length === 0) {
        const welcomeMsg = t('pbl.chat.welcomeMessage')
          .replace('{title}', activeIssue.title)
          .replace('{questions}', activeIssue.generated_questions);
        newConfig.chat = {
          messages: [
            {
              id: `msg_welcome_${Date.now()}`,
              agent_name: activeIssue.question_agent_name,
              message: welcomeMsg,
              timestamp: Date.now(),
              read_by: [],
            },
          ],
        };
```

### components/whiteboard/index.tsx
```
'use client';

import { useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Eraser, Minimize2, PencilLine } from 'lucide-react';
import { WhiteboardCanvas } from './whiteboard-canvas';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { createStageAPI } from '@/lib/api/stage-api';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';

interface WhiteboardProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

/**
 * Whiteboard component
 */
export function Whiteboard({ isOpen, onClose }: WhiteboardProps) {
  const { t } = useI18n();
  const stage = useStageStore.use.stage();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const clearingRef = useRef(false);

  // Get element count for indicator
  const whiteboard = stage?.whiteboard?.[0];
  const elementCount = whiteboard?.elements?.length || 0;

  const stageAPI = createStageAPI(useStageStore);

  const handleClear = async () => {
    if (!whiteboard || elementCount === 0 || clearingRef.current) return;
    clearingRef.current = true;

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await new Promise((resolve) => setTimeout(resolve, animMs));

    // Actually remove elements
    const result = stageAPI.whiteboard.delete(whiteboard.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
    clearingRef.current = false;

    if (result.success) {
      toast.success(t('whiteboard.clearSuccess'));
    } else {
      toast.error(t('whiteboard.clearError') + result.error);
    }
  };

  return (
    <>
      {/* Main Whiteboard Overlay */}
      <AnimatePresence>
        {isOpen && (
```

### components/whiteboard/whiteboard-canvas.tsx
```
'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import type { PPTElement } from '@/lib/types/slides';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * Animated element wrapper
 */
function AnimatedElement({
  element,
  index,
  isClearing,
  totalElements,
}: {
  element: PPTElement;
  index: number;
  isClearing: boolean;
  totalElements: number;
}) {
  // Reverse stagger: last-drawn element exits first for a "wipe" cascade
  const clearDelay = isClearing ? (totalElements - 1 - index) * 0.055 : 0;
  // Alternate tilt direction for organic feel
  const clearRotate = isClearing ? (index % 2 === 0 ? 1 : -1) * (2 + index * 0.4) : 0;

  return (
    <motion.div
      layout={false}
      initial={{ opacity: 0, scale: 0.92, y: 8, filter: 'blur(4px)' }}
      animate={
        isClearing
          ? {
              opacity: 0,
              scale: 0.35,
              y: -35,
              rotate: clearRotate,
              filter: 'blur(8px)',
              transition: {
                duration: 0.38,
                delay: clearDelay,
                ease: [0.5, 0, 1, 0.6],
              },
            }
          : {
              opacity: 1,
              scale: 1,
              y: 0,
              rotate: 0,
              filter: 'blur(0px)',
              transition: {
                duration: 0.45,
                ease: [0.16, 1, 0.3, 1],
                delay: index * 0.05,
              },
            }
      }
```

### components/generation/generating-progress.tsx
```
'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

interface GeneratingProgressProps {
  outlineReady: boolean; // Is outline generation complete?
  firstPageReady: boolean; // Is first page generated?
  statusMessage: string;
  error?: string | null;
}

// Status item component - declared outside main component
function StatusItem({
  completed,
  inProgress,
  hasError,
  label,
}: {
  completed: boolean;
  inProgress: boolean;
  hasError: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-shrink-0">
        {hasError ? (
          <XCircle className="size-6 text-destructive" />
        ) : completed ? (
          <CheckCircle2 className="size-6 text-green-500" />
        ) : inProgress ? (
          <Loader2 className="size-6 text-primary animate-spin" />
        ) : (
          <Circle className="size-6 text-muted-foreground" />
        )}
      </div>
      <span
        className={`text-base ${
          hasError
            ? 'text-destructive'
            : completed
              ? 'text-green-600 font-medium'
              : inProgress
                ? 'text-primary font-medium'
                : 'text-muted-foreground'
        }`}
      >
        {label}
      </span>
    </div>
  );
}

export function GeneratingProgress({
  outlineReady,
  firstPageReady,
  statusMessage,
```

### components/generation/media-popover.tsx
```
'use client';

import { useState, useRef, useCallback, useMemo, Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Image as ImageIcon,
  Video,
  Volume2,
  Mic,
  SlidersHorizontal,
  ChevronRight,
  Play,
  Loader2,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { TTS_PROVIDERS, getTTSVoices } from '@/lib/audio/constants';
import { ASR_PROVIDERS, getASRSupportedLanguages } from '@/lib/audio/constants';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { ASRProviderId } from '@/lib/audio/types';
import type { SettingsSection } from '@/lib/types/settings';

interface MediaPopoverProps {
  onSettingsOpen: (section: SettingsSection) => void;
}

// ─── Provider icon maps ───
const IMAGE_PROVIDER_ICONS: Record<string, string> = {
  seedream: '/logos/doubao.svg',
  'qwen-image': '/logos/bailian.svg',
  'nano-banana': '/logos/gemini.svg',
};
const VIDEO_PROVIDER_ICONS: Record<string, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  sora: '/logos/openai.svg',
};

type TabId = 'image' | 'video' | 'tts' | 'asr';

const TABS: Array<{ id: TabId; icon: LucideIcon; label: string }> = [
  { id: 'image', icon: ImageIcon, label: 'Image' },
  { id: 'video', icon: Video, label: 'Video' },
```

### components/generation/outlines-editor.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { SceneOutline } from '@/lib/types/generation';

interface OutlinesEditorProps {
  outlines: SceneOutline[];
  onChange: (outlines: SceneOutline[]) => void;
  onConfirm: () => void;
  onBack: () => void;
  isLoading?: boolean;
}

export function OutlinesEditor({
  outlines,
  onChange,
  onConfirm,
  onBack,
  isLoading = false,
}: OutlinesEditorProps) {
  const addOutline = () => {
    const newOutline: SceneOutline = {
      id: nanoid(8),
      type: 'slide',
      title: '',
      description: '',
      keyPoints: [],
      order: outlines.length + 1,
    };
    onChange([...outlines, newOutline]);
  };

  const updateOutline = (index: number, updates: Partial<SceneOutline>) => {
    const newOutlines = [...outlines];
    newOutlines[index] = { ...newOutlines[index], ...updates };
    onChange(newOutlines);
  };

  const removeOutline = (index: number) => {
    const newOutlines = outlines.filter((_, i) => i !== index);
    // Update order
    newOutlines.forEach((outline, i) => {
      outline.order = i + 1;
    });
    onChange(newOutlines);
  };

```

### components/generation/generation-toolbar.tsx
```
'use client';

import { useState, useRef, useMemo } from 'react';
import { Bot, Check, ChevronLeft, Globe, Paperclip, FileText, X, Globe2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import type { ProviderId } from '@/lib/ai/providers';
import type { SettingsSection } from '@/lib/types/settings';
import { MediaPopover } from '@/components/generation/media-popover';

// ─── Constants ───────────────────────────────────────────────
const MAX_PDF_SIZE_MB = 50;
const MAX_PDF_SIZE_BYTES = MAX_PDF_SIZE_MB * 1024 * 1024;

// ─── Types ───────────────────────────────────────────────────
export interface GenerationToolbarProps {
  language: 'zh-CN' | 'en-US';
  onLanguageChange: (lang: 'zh-CN' | 'en-US') => void;
  webSearch: boolean;
  onWebSearchChange: (v: boolean) => void;
  onSettingsOpen: (section?: SettingsSection) => void;
  // PDF
  pdfFile: File | null;
  onPdfFileChange: (file: File | null) => void;
  onPdfError: (error: string | null) => void;
}

// ─── Component ───────────────────────────────────────────────
export function GenerationToolbar({
  language,
  onLanguageChange,
  webSearch,
  onWebSearchChange,
  onSettingsOpen,
  pdfFile,
  onPdfFileChange,
  onPdfError,
}: GenerationToolbarProps) {
  const { t } = useI18n();
  const currentProviderId = useSettingsStore((s) => s.providerId);
  const currentModelId = useSettingsStore((s) => s.modelId);
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const setModel = useSettingsStore((s) => s.setModel);
  const pdfProviderId = useSettingsStore((s) => s.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((s) => s.pdfProvidersConfig);
  const setPDFProvider = useSettingsStore((s) => s.setPDFProvider);
```

### components/agent/agent-bar.tsx
```
'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { Sparkles, ChevronDown, ChevronUp, Shuffle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function AgentBar() {
  const { t } = useI18n();
  const { listAgents } = useAgentRegistry();
  const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
  const setSelectedAgentIds = useSettingsStore((s) => s.setSelectedAgentIds);
  const maxTurns = useSettingsStore((s) => s.maxTurns);
  const setMaxTurns = useSettingsStore((s) => s.setMaxTurns);
  const agentMode = useSettingsStore((s) => s.agentMode);
  const setAgentMode = useSettingsStore((s) => s.setAgentMode);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const allAgents = listAgents();
  // In preset mode, only show default (non-generated) agents
  const agents = allAgents.filter((a) => !a.isGenerated);
  const teacherAgent = agents.find((a) => a.role === 'teacher');
  const selectedAgents = agents.filter((a) => selectedAgentIds.includes(a.id));
  const nonTeacherSelected = selectedAgents.filter((a) => a.role !== 'teacher');

  // Click-outside to collapse
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleModeChange = (mode: 'preset' | 'auto') => {
    setAgentMode(mode);
    if (mode === 'preset') {
      // Ensure a teacher is always selected in preset mode
      const hasTeacherSelected = selectedAgentIds.some((id) => {
        const a = agents.find((agent) => agent.id === id);
        return a?.role === 'teacher';
      });
      if (!hasTeacherSelected && teacherAgent) {
        setSelectedAgentIds([teacherAgent.id, ...selectedAgentIds]);
      }
    }
  };

  const toggleAgent = (agentId: string) => {
```

### components/agent/agent-avatar.tsx
```
/**
 * Agent Avatar Component
 * Displays agent avatar and name in chat messages
 */

import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

interface AgentAvatarProps {
  avatar: string; // Image URL or emoji
  color: string; // Theme color (hex)
  name: string; // Agent display name
  size?: 'sm' | 'md' | 'lg';
}

// Check if string is a URL
function isUrl(str: string): boolean {
  return str.startsWith('http') || str.startsWith('/') || str.startsWith('data:');
}

export default function AgentAvatar({ avatar, color, name, size = 'md' }: AgentAvatarProps) {
  const sizeClasses = {
    sm: 'size-6',
    md: 'size-8',
    lg: 'size-10',
  };

  return (
    <div className="flex items-center gap-2 mb-2">
      <Avatar className={sizeClasses[size]} style={{ borderColor: color, borderWidth: 2 }}>
        {isUrl(avatar) ? (
          <>
            <AvatarImage src={avatar} alt={name} />
            <AvatarFallback style={{ backgroundColor: `${color}20`, color }}>
              {name.charAt(0)}
            </AvatarFallback>
          </>
        ) : (
          <AvatarFallback style={{ backgroundColor: `${color}20`, color }}>
            {avatar || name.charAt(0)}
          </AvatarFallback>
        )}
      </Avatar>
      <span className="text-sm font-semibold" style={{ color }}>
        {name}
      </span>
    </div>
  );
}
```

### components/agent/agent-reveal-modal.tsx
```
'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';

interface AgentRevealModalProps {
  agents: Array<{
    id: string;
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
  }>;
  open: boolean;
  onClose: () => void;
  /** Called once after all cards are revealed — signals generation can continue */
  onAllRevealed?: () => void;
}

function isUrl(str: string): boolean {
  return str.startsWith('http') || str.startsWith('/') || str.startsWith('data:');
}

/** Lighten a hex color by mixing with white */
function lighten(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `rgb(${lr},${lg},${lb})`;
}

const ROLE_ICONS: Record<string, string> = {
  teacher: '👨‍🏫',
  assistant: '🤝',
  student: '🎓',
};

export function AgentRevealModal({ agents, open, onClose, onAllRevealed }: AgentRevealModalProps) {
  const { t } = useI18n();
  const [revealedCount, setRevealedCount] = useState(0);
  const [flipsComplete, setFlipsComplete] = useState(false);
  const allRevealedFiredRef = useRef(false);
  const onAllRevealedRef = useRef(onAllRevealed);
  onAllRevealedRef.current = onAllRevealed;

  const allRevealed = revealedCount >= agents.length && agents.length > 0;

  useEffect(() => {
    if (!open) {
      setRevealedCount(0);
      setFlipsComplete(false);
      allRevealedFiredRef.current = false;
      return;
```

### components/agent/agent-config-panel.tsx
```
/**
 * Agent Configuration Panel
 * UI for viewing and managing AI agents in the registry
 */

'use client';

import { useState } from 'react';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { PlusIcon, Trash2Icon, EditIcon } from 'lucide-react';

export function AgentConfigPanel() {
  const { listAgents, deleteAgent } = useAgentRegistry();
  const agents = listAgents();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const handleDelete = (agentId: string) => {
    if (confirm('确定要删除这个智能体吗？')) {
      deleteAgent(agentId);
      if (selectedAgent === agentId) {
        setSelectedAgent(null);
      }
    }
  };

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">智能体配置</h2>
          <p className="text-sm text-muted-foreground">管理课堂讨论的AI智能体</p>
        </div>
        <Button size="sm" variant="outline">
          <PlusIcon className="w-4 h-4 mr-2" />
          新建
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3">
          {agents.map((agent) => (
            <Card
              key={agent.id}
              className={`cursor-pointer transition-colors ${
                selectedAgent === agent.id ? 'border-primary' : ''
              }`}
              onClick={() => setSelectedAgent(agent.id)}
            >
              <CardHeader className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar
                      className="size-10"
                      style={{
                        borderColor: agent.color,
```

### components/audio/tts-config-popover.tsx
```
'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { Volume2, Play, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { getTTSVoices } from '@/lib/audio/constants';

/** Extract the English name from voice name format "ChineseName (English)" */
function getVoiceDisplayName(name: string, lang: string): string {
  if (lang === 'en-US') {
    const match = name.match(/\(([^)]+)\)/);
    return match ? match[1] : name;
  }
  return name;
}

export function TtsConfigPopover() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);

  const voices = getTTSVoices(ttsProviderId);
  const localizedVoices = useMemo(
    () =>
      voices.map((v) => ({
        ...v,
        displayName: getVoiceDisplayName(v.name, locale),
      })),
    [voices, locale],
  );

  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';

  const handlePreview = useCallback(async () => {
    if (previewing) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPreviewing(false);
      return;
```

### components/audio/speech-button.tsx
```
'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';

interface SpeechButtonProps {
  onTranscription: (text: string) => void;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function SpeechButton({
  onTranscription,
  className,
  disabled,
  size = 'sm',
}: SpeechButtonProps) {
  const { t } = useI18n();

  // Ref to always call the latest onTranscription, avoiding stale closures
  const onTranscriptionRef = useRef(onTranscription);
  useEffect(() => {
    onTranscriptionRef.current = onTranscription;
  }, [onTranscription]);

  const stableOnTranscription = useCallback((text: string) => {
    onTranscriptionRef.current(text);
  }, []);

  const handleError = useCallback((error: string) => {
    toast.error(error);
  }, []);

  const { isRecording, isProcessing, startRecording, stopRecording } = useAudioRecorder({
    onTranscription: stableOnTranscription,
    onError: handleError,
  });

  const active = isRecording || isProcessing;

  const handleClick = () => {
    if (isRecording) {
      stopRecording();
    } else if (!isProcessing) {
      startRecording();
    }
  };

  const isMd = size === 'md';
  const sizeClasses = isMd ? 'h-8 w-8' : 'h-6 w-6';
  const iconSize = isMd ? 'w-4 h-4' : 'w-3.5 h-3.5';
  const barH = isMd ? 14 : 10;

  return (
```

### components/ai-elements/open-in-chat.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ChevronDownIcon, ExternalLinkIcon, MessageCircleIcon } from 'lucide-react';
import { type ComponentProps, createContext, useContext } from 'react';

const providers = {
  github: {
    title: 'Open in GitHub',
    createUrl: (url: string) => url,
    icon: (
      <svg fill="currentColor" role="img" viewBox="0 0 24 24">
        <title>GitHub</title>
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    ),
  },
  scira: {
    title: 'Open in Scira',
    createUrl: (q: string) =>
      `https://scira.ai/?${new URLSearchParams({
        q,
      })}`,
    icon: (
      <svg
        fill="none"
        height="934"
        viewBox="0 0 910 934"
        width="910"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Scira AI</title>
        <path
          d="M647.664 197.775C569.13 189.049 525.5 145.419 516.774 66.8849C508.048 145.419 464.418 189.049 385.884 197.775C464.418 206.501 508.048 250.131 516.774 328.665C525.5 250.131 569.13 206.501 647.664 197.775Z"
          fill="currentColor"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="8"
        />
        <path
          d="M516.774 304.217C510.299 275.491 498.208 252.087 480.335 234.214C462.462 216.341 439.058 204.251 410.333 197.775C439.059 191.3 462.462 179.209 480.335 161.336C498.208 143.463 510.299 120.06 516.774 91.334C523.25 120.059 535.34 143.463 553.213 161.336C571.086 179.209 594.49 191.3 623.216 197.775C594.49 204.251 571.086 216.341 553.213 234.214C535.34 252.087 523.25 275.491 516.774 304.217Z"
          fill="currentColor"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="8"
        />
        <path
          d="M857.5 508.116C763.259 497.644 710.903 445.288 700.432 351.047C689.961 445.288 637.605 497.644 543.364 508.116C637.605 518.587 689.961 570.943 700.432 665.184C710.903 570.943 763.259 518.587 857.5 508.116Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="20"
```

### components/ai-elements/model-selector.tsx
```
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { ComponentProps, ReactNode } from 'react';

export type ModelSelectorProps = ComponentProps<typeof Dialog>;

export const ModelSelector = (props: ModelSelectorProps) => <Dialog {...props} />;

export type ModelSelectorTriggerProps = ComponentProps<typeof DialogTrigger>;

export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
  <DialogTrigger {...props} />
);

export type ModelSelectorContentProps = ComponentProps<typeof DialogContent> & {
  title?: ReactNode;
};

export const ModelSelectorContent = ({
  className,
  children,
  title = 'Model Selector',
  ...props
}: ModelSelectorContentProps) => (
  <DialogContent className={cn('p-0', className)} {...props}>
    <DialogTitle className="sr-only">{title}</DialogTitle>
    <Command className="**:data-[slot=command-input-wrapper]:h-auto">{children}</Command>
  </DialogContent>
);

export type ModelSelectorDialogProps = ComponentProps<typeof CommandDialog>;

export const ModelSelectorDialog = (props: ModelSelectorDialogProps) => (
  <CommandDialog {...props} />
);

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export const ModelSelectorInput = ({ className, ...props }: ModelSelectorInputProps) => (
  <CommandInput className={cn('h-auto py-3.5', className)} {...props} />
);

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export const ModelSelectorList = (props: ModelSelectorListProps) => <CommandList {...props} />;

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => <CommandEmpty {...props} />;
```

### components/ai-elements/web-preview.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

export type WebPreviewContextValue = {
  url: string;
  setUrl: (url: string) => void;
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
};

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

const useWebPreview = () => {
  const context = useContext(WebPreviewContext);
  if (!context) {
    throw new Error('WebPreview components must be used within a WebPreview');
  }
  return context;
};

export type WebPreviewProps = ComponentProps<'div'> & {
  defaultUrl?: string;
  onUrlChange?: (url: string) => void;
};

export const WebPreview = ({
  className,
  children,
  defaultUrl = '',
  onUrlChange,
  ...props
}: WebPreviewProps) => {
  const [url, setUrl] = useState(defaultUrl);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const handleUrlChange = (newUrl: string) => {
    setUrl(newUrl);
    onUrlChange?.(newUrl);
  };

  const contextValue: WebPreviewContextValue = {
    url,
    setUrl: handleUrlChange,
    consoleOpen,
    setConsoleOpen,
  };

  return (
    <WebPreviewContext.Provider value={contextValue}>
      <div
        className={cn('flex size-full flex-col rounded-lg border bg-card', className)}
        {...props}
```

### components/ai-elements/reasoning.tsx
```
'use client';

import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useEffect, useState } from 'react';
import { Streamdown } from 'streamdown';
import { Shimmer } from './shimmer';

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: undefined,
    });

```

### components/ai-elements/sources.tsx
```
'use client';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { BookIcon, ChevronDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

export type SourcesProps = ComponentProps<'div'>;

export const Sources = ({ className, ...props }: SourcesProps) => (
  <Collapsible className={cn('not-prose mb-4 text-primary text-xs', className)} {...props} />
);

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
};

export const SourcesTrigger = ({ className, count, children, ...props }: SourcesTriggerProps) => (
  <CollapsibleTrigger className={cn('flex items-center gap-2', className)} {...props}>
    {children ?? (
      <>
        <p className="font-medium">Used {count} sources</p>
        <ChevronDownIcon className="h-4 w-4" />
      </>
    )}
  </CollapsibleTrigger>
);

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export const SourcesContent = ({ className, ...props }: SourcesContentProps) => (
  <CollapsibleContent
    className={cn(
      'mt-3 flex w-fit flex-col gap-2',
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
);

export type SourceProps = ComponentProps<'a'>;

export const Source = ({ href, title, children, ...props }: SourceProps) => (
  <a className="flex items-center gap-2" href={href} rel="noreferrer" target="_blank" {...props}>
    {children ?? (
      <>
        <BookIcon className="h-4 w-4" />
        <span className="block font-medium">{title}</span>
      </>
    )}
  </a>
);
```

### components/ai-elements/context.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { LanguageModelUsage } from 'ai';
import { type ComponentProps, createContext, useContext } from 'react';
import { getUsage } from 'tokenlens';

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

type ModelId = string;

type ContextSchema = {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
};

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error('Context components must be used within Context');
  }

  return context;
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => (
  <ContextContext.Provider
    value={{
      usedTokens,
      maxTokens,
      usage,
      modelId,
    }}
  >
    <HoverCard closeDelay={0} openDelay={0} {...props} />
  </ContextContext.Provider>
);

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = usedTokens / maxTokens;
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
```

### components/ai-elements/panel.tsx
```
import { cn } from '@/lib/utils';
import { Panel as PanelPrimitive } from '@xyflow/react';
import type { ComponentProps } from 'react';

type PanelProps = ComponentProps<typeof PanelPrimitive>;

export const Panel = ({ className, ...props }: PanelProps) => (
  <PanelPrimitive
    className={cn('m-4 overflow-hidden rounded-md border bg-card p-1', className)}
    {...props}
  />
);
```

### components/ai-elements/edge.tsx
```
import {
  BaseEdge,
  type EdgeProps,
  getBezierPath,
  getSimpleBezierPath,
  type InternalNode,
  type Node,
  Position,
  useInternalNode,
} from '@xyflow/react';

const Temporary = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) => {
  const [edgePath] = getSimpleBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <BaseEdge
      className="stroke-1 stroke-ring"
      id={id}
      path={edgePath}
      style={{
        strokeDasharray: '5, 5',
      }}
    />
  );
};

const getHandleCoordsByPosition = (node: InternalNode<Node>, handlePosition: Position) => {
  // Choose the handle type based on position - Left is for target, Right is for source
  const handleType = handlePosition === Position.Left ? 'target' : 'source';

  const handle = node.internals.handleBounds?.[handleType]?.find(
    (h) => h.position === handlePosition,
  );

  if (!handle) {
    return [0, 0] as const;
  }

  let offsetX = handle.width / 2;
  let offsetY = handle.height / 2;

  // this is a tiny detail to make the markerEnd of an edge visible.
  // The handle position that gets calculated has the origin top-left, so depending which side we are using, we add a little offset
  // when the handlePosition is Position.Right for example, we need to add an offset as big as the handle itself in order to get the correct position
  switch (handlePosition) {
```

### components/ai-elements/suggestion.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

export type SuggestionsProps = ComponentProps<typeof ScrollArea>;

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
  <ScrollArea className="w-full overflow-x-auto whitespace-nowrap" {...props}>
    <div className={cn('flex w-max flex-nowrap items-center gap-2', className)}>{children}</div>
    <ScrollBar className="hidden" orientation="horizontal" />
  </ScrollArea>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = 'outline',
  size = 'sm',
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = () => {
    onClick?.(suggestion);
  };

  return (
    <Button
      className={cn('cursor-pointer rounded-full px-4', className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
```

### components/ai-elements/checkpoint.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { BookmarkIcon, type LucideProps } from 'lucide-react';
import type { ComponentProps, HTMLAttributes } from 'react';

export type CheckpointProps = HTMLAttributes<HTMLDivElement>;

export const Checkpoint = ({ className, children, ...props }: CheckpointProps) => (
  <div
    className={cn('flex items-center gap-0.5 text-muted-foreground overflow-hidden', className)}
    {...props}
  >
    {children}
    <Separator />
  </div>
);

export type CheckpointIconProps = LucideProps;

export const CheckpointIcon = ({ className, children, ...props }: CheckpointIconProps) =>
  children ?? <BookmarkIcon className={cn('size-4 shrink-0', className)} {...props} />;

export type CheckpointTriggerProps = ComponentProps<typeof Button> & {
  tooltip?: string;
};

export const CheckpointTrigger = ({
  children,
  variant = 'ghost',
  size = 'sm',
  tooltip,
  ...props
}: CheckpointTriggerProps) =>
  tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size={size} type="button" variant={variant} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent align="start" side="bottom">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  ) : (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
    </Button>
  );
```

### components/ai-elements/chain-of-thought.tsx
```
'use client';

import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { BrainIcon, ChevronDownIcon, DotIcon, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useMemo } from 'react';

type ChainOfThoughtContextValue = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
};

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error('ChainOfThought components must be used within ChainOfThought');
  }
  return context;
};

export type ChainOfThoughtProps = ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const ChainOfThought = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    const chainOfThoughtContext = useMemo(() => ({ isOpen, setIsOpen }), [isOpen, setIsOpen]);

    return (
      <ChainOfThoughtContext.Provider value={chainOfThoughtContext}>
        <div className={cn('not-prose max-w-prose space-y-4', className)} {...props}>
          {children}
        </div>
      </ChainOfThoughtContext.Provider>
    );
  },
);

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger>;

```

### components/ai-elements/confirmation.tsx
```
'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ToolUIPart } from 'ai';
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';

type ToolUIPartApproval =
  | {
      id: string;
      approved?: never;
      reason?: never;
    }
  | {
      id: string;
      approved: boolean;
      reason?: string;
    }
  | {
      id: string;
      approved: true;
      reason?: string;
    }
  | {
      id: string;
      approved: true;
      reason?: string;
    }
  | {
      id: string;
      approved: false;
      reason?: string;
    }
  | undefined;

type ConfirmationContextValue = {
  approval: ToolUIPartApproval;
  state: ToolUIPart['state'];
};

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null);

const useConfirmation = () => {
  const context = useContext(ConfirmationContext);

  if (!context) {
    throw new Error('Confirmation components must be used within Confirmation');
  }

  return context;
};

export type ConfirmationProps = ComponentProps<typeof Alert> & {
  approval?: ToolUIPartApproval;
  state: ToolUIPart['state'];
};

export const Confirmation = ({ className, approval, state, ...props }: ConfirmationProps) => {
  if (!approval || state === 'input-streaming' || state === 'input-available') {
```

### components/ai-elements/loader.tsx
```
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

type LoaderIconProps = {
  size?: number;
};

const LoaderIcon = ({ size = 16 }: LoaderIconProps) => (
  <svg
    height={size}
    strokeLinejoin="round"
    style={{ color: 'currentcolor' }}
    viewBox="0 0 16 16"
    width={size}
  >
    <title>Loader</title>
    <g clipPath="url(#clip0_2393_1490)">
      <path d="M8 0V4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 16V12" opacity="0.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M3.29773 1.52783L5.64887 4.7639"
        opacity="0.9"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M12.7023 1.52783L10.3511 4.7639"
        opacity="0.1"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M12.7023 14.472L10.3511 11.236"
        opacity="0.4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M3.29773 14.472L5.64887 11.236"
        opacity="0.6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M15.6085 5.52783L11.8043 6.7639"
        opacity="0.2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M0.391602 10.472L4.19583 9.23598"
        opacity="0.7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M15.6085 10.4722L11.8043 9.2361"
        opacity="0.3"
        stroke="currentColor"
        strokeWidth="1.5"
```

### components/ai-elements/tool.tsx
```
'use client';

import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ToolUIPart } from 'ai';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { isValidElement } from 'react';
import { CodeBlock } from './code-block';

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn('not-prose mb-4 w-full rounded-md border', className)} {...props} />
);

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart['type'];
  state: ToolUIPart['state'];
  className?: string;
};

const getStatusBadge = (status: ToolUIPart['state']) => {
  const labels: Record<ToolUIPart['state'], string> = {
    'input-streaming': 'Pending',
    'input-available': 'Running',
    'approval-requested': 'Awaiting Approval',
    'approval-responded': 'Responded',
    'output-available': 'Completed',
    'output-error': 'Error',
    'output-denied': 'Denied',
  };

  const icons: Record<ToolUIPart['state'], ReactNode> = {
    'input-streaming': <CircleIcon className="size-4" />,
    'input-available': <ClockIcon className="size-4 animate-pulse" />,
    'approval-requested': <ClockIcon className="size-4 text-yellow-600" />,
    'approval-responded': <CheckCircleIcon className="size-4 text-blue-600" />,
    'output-available': <CheckCircleIcon className="size-4 text-green-600" />,
    'output-error': <XCircleIcon className="size-4 text-red-600" />,
    'output-denied': <XCircleIcon className="size-4 text-orange-600" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

```

### components/ai-elements/image.tsx
```
import { cn } from '@/lib/utils';
import type { Experimental_GeneratedImage } from 'ai';

export type ImageProps = Experimental_GeneratedImage & {
  className?: string;
  alt?: string;
};

export const Image = ({ base64, mediaType, ...props }: ImageProps) => (
  <img
    {...props}
    alt={props.alt}
    className={cn('h-auto max-w-full overflow-hidden rounded-md', props.className)}
    src={`data:${mediaType};base64,${base64}`}
  />
);
```

### components/ai-elements/node.tsx
```
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Handle, Position } from '@xyflow/react';
import type { ComponentProps } from 'react';

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean;
    source: boolean;
  };
};

export const Node = ({ handles, className, ...props }: NodeProps) => (
  <Card
    className={cn('node-container relative size-full h-auto w-sm gap-0 rounded-md p-0', className)}
    {...props}
  >
    {handles.target && <Handle position={Position.Left} type="target" />}
    {handles.source && <Handle position={Position.Right} type="source" />}
    {props.children}
  </Card>
);

export type NodeHeaderProps = ComponentProps<typeof CardHeader>;

export const NodeHeader = ({ className, ...props }: NodeHeaderProps) => (
  <CardHeader
    className={cn('gap-0.5 rounded-t-md border-b bg-secondary p-3!', className)}
    {...props}
  />
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = (props: NodeTitleProps) => <CardTitle {...props} />;

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = (props: NodeDescriptionProps) => <CardDescription {...props} />;

export type NodeActionProps = ComponentProps<typeof CardAction>;

export const NodeAction = (props: NodeActionProps) => <CardAction {...props} />;

export type NodeContentProps = ComponentProps<typeof CardContent>;

export const NodeContent = ({ className, ...props }: NodeContentProps) => (
  <CardContent className={cn('p-3', className)} {...props} />
);

export type NodeFooterProps = ComponentProps<typeof CardFooter>;

```

### components/ai-elements/artifact.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type LucideIcon, XIcon } from 'lucide-react';
import type { ComponentProps, HTMLAttributes } from 'react';

export type ArtifactProps = HTMLAttributes<HTMLDivElement>;

export const Artifact = ({ className, ...props }: ArtifactProps) => (
  <div
    className={cn(
      'flex flex-col overflow-hidden rounded-lg border bg-background shadow-sm',
      className,
    )}
    {...props}
  />
);

export type ArtifactHeaderProps = HTMLAttributes<HTMLDivElement>;

export const ArtifactHeader = ({ className, ...props }: ArtifactHeaderProps) => (
  <div
    className={cn('flex items-center justify-between border-b bg-muted/50 px-4 py-3', className)}
    {...props}
  />
);

export type ArtifactCloseProps = ComponentProps<typeof Button>;

export const ArtifactClose = ({
  className,
  children,
  size = 'sm',
  variant = 'ghost',
  ...props
}: ArtifactCloseProps) => (
  <Button
    className={cn('size-8 p-0 text-muted-foreground hover:text-foreground', className)}
    size={size}
    type="button"
    variant={variant}
    {...props}
  >
    {children ?? <XIcon className="size-4" />}
    <span className="sr-only">Close</span>
  </Button>
);

export type ArtifactTitleProps = HTMLAttributes<HTMLParagraphElement>;

export const ArtifactTitle = ({ className, ...props }: ArtifactTitleProps) => (
  <p className={cn('font-medium text-foreground text-sm', className)} {...props} />
);

export type ArtifactDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const ArtifactDescription = ({ className, ...props }: ArtifactDescriptionProps) => (
  <p className={cn('text-muted-foreground text-sm', className)} {...props} />
```

### components/ai-elements/task.tsx
```
'use client';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ChevronDownIcon, SearchIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

export type TaskItemFileProps = ComponentProps<'div'>;

export const TaskItemFile = ({ children, className, ...props }: TaskItemFileProps) => (
  <div
    className={cn(
      'inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-foreground text-xs',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<'div'>;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn('text-muted-foreground text-sm', className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({ children, className, title, ...props }: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn('group', className)} {...props}>
    {children ?? (
      <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <SearchIcon className="size-4" />
        <p className="text-sm">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
```

### components/ai-elements/code-block.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CheckIcon, CopyIcon } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type BundledLanguage, codeToHtml, type ShikiTransformer } from 'shiki';

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: '',
});

const lineNumberTransformer: ShikiTransformer = {
  name: 'line-numbers',
  line(node, line) {
    node.children.unshift({
      type: 'element',
      tagName: 'span',
      properties: {
        className: [
          'inline-block',
          'min-w-10',
          'mr-4',
          'text-right',
          'select-none',
          'text-muted-foreground',
        ],
      },
      children: [{ type: 'text', value: String(line) }],
    });
  },
};

export async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false,
) {
  const transformers: ShikiTransformer[] = showLineNumbers ? [lineNumberTransformer] : [];

  return await Promise.all([
    codeToHtml(code, {
```

### components/ai-elements/plan.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ChevronsUpDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { createContext, useContext } from 'react';
import { Shimmer } from './shimmer';

type PlanContextValue = {
  isStreaming: boolean;
};

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error('Plan components must be used within Plan');
  }
  return context;
};

export type PlanProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
};

export const Plan = ({ className, isStreaming = false, children, ...props }: PlanProps) => (
  <PlanContext.Provider value={{ isStreaming }}>
    <Collapsible asChild data-slot="plan" {...props}>
      <Card className={cn('shadow-none', className)}>{children}</Card>
    </Collapsible>
  </PlanContext.Provider>
);

export type PlanHeaderProps = ComponentProps<typeof CardHeader>;

export const PlanHeader = ({ className, ...props }: PlanHeaderProps) => (
  <CardHeader
    className={cn('flex items-start justify-between', className)}
    data-slot="plan-header"
    {...props}
  />
);

export type PlanTitleProps = Omit<ComponentProps<typeof CardTitle>, 'children'> & {
  children: string;
};

export const PlanTitle = ({ children, ...props }: PlanTitleProps) => {
```

### components/ai-elements/toolbar.tsx
```
import { cn } from '@/lib/utils';
import { NodeToolbar, Position } from '@xyflow/react';
import type { ComponentProps } from 'react';

type ToolbarProps = ComponentProps<typeof NodeToolbar>;

export const Toolbar = ({ className, ...props }: ToolbarProps) => (
  <NodeToolbar
    className={cn('flex items-center gap-1 rounded-sm border bg-background p-1.5', className)}
    position={Position.Bottom}
    {...props}
  />
);
```

### components/ai-elements/connection.tsx
```
import type { ConnectionLineComponent } from '@xyflow/react';

const HALF = 0.5;

export const Connection: ConnectionLineComponent = ({ fromX, fromY, toX, toY }) => (
  <g>
    <path
      className="animated"
      d={`M${fromX},${fromY} C ${fromX + (toX - fromX) * HALF},${fromY} ${fromX + (toX - fromX) * HALF},${toY} ${toX},${toY}`}
      fill="none"
      stroke="var(--color-ring)"
      strokeWidth={1}
    />
    <circle cx={toX} cy={toY} fill="#fff" r={3} stroke="var(--color-ring)" strokeWidth={1} />
  </g>
);
```

### components/ai-elements/prompt-input.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import type { ChatStatus, FileUIPart } from 'ai';

const log = createLogger('PromptInput');
import {
  CornerDownLeftIcon,
  ImageIcon,
  Loader2Icon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import {
  type ChangeEvent,
  type ChangeEventHandler,
  Children,
  type ClipboardEventHandler,
  type ComponentProps,
  createContext,
  type FormEvent,
  type FormEventHandler,
  Fragment,
  type HTMLAttributes,
  type KeyboardEventHandler,
```

### components/ai-elements/conversation.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArrowDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-8 p-4', className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = 'No messages yet',
  description = 'Start a conversation to see messages here',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);

```

### components/ai-elements/shimmer.tsx
```
'use client';

import { cn } from '@/lib/utils';
import { type MotionProps, motion } from 'motion/react';
import { type CSSProperties, type ElementType, type JSX, memo, useMemo, useRef } from 'react';

type MotionComponentType = React.FC<
  MotionProps & React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }
>;

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

/* eslint-disable react-hooks/refs -- Ref-based cache for motion.create component identity */
const ShimmerComponent = ({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const motionRef = useRef<MotionComponentType | null>(null);
  const prevComponentRef = useRef(Component);
  if (!motionRef.current || prevComponentRef.current !== Component) {
    motionRef.current = motion.create(
      Component as keyof JSX.IntrinsicElements,
    ) as unknown as MotionComponentType;
    prevComponentRef.current = Component;
  }
  const MotionComponent = motionRef.current;

  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return (
    <MotionComponent
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage:
            'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: 'linear',
      }}
    >
```

### components/ai-elements/message.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FileUIPart, UIMessage } from 'ai';
import { ChevronLeftIcon, ChevronRightIcon, PaperclipIcon, XIcon } from 'lucide-react';
import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import { Streamdown } from 'streamdown';

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role'];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full max-w-[95%] flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground',
      'group-[.is-assistant]:text-foreground',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<'div'>;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
```

### components/ai-elements/canvas.tsx
```
import { Background, ReactFlow, type ReactFlowProps } from '@xyflow/react';
import type { ReactNode } from 'react';
import '@xyflow/react/dist/style.css';

type CanvasProps = ReactFlowProps & {
  children?: ReactNode;
};

export const Canvas = ({ children, ...props }: CanvasProps) => (
  <ReactFlow
    deleteKeyCode={['Backspace', 'Delete']}
    fitView
    panOnDrag={false}
    panOnScroll
    selectionOnDrag={true}
    zoomOnDoubleClick={false}
    {...props}
  >
    <Background bgColor="var(--sidebar)" />
    {children}
  </ReactFlow>
);
```

### components/ai-elements/queue.tsx
```
'use client';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ChevronDownIcon, PaperclipIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

export type QueueMessagePart = {
  type: string;
  text?: string;
  url?: string;
  filename?: string;
  mediaType?: string;
};

export type QueueMessage = {
  id: string;
  parts: QueueMessagePart[];
};

export type QueueTodo = {
  id: string;
  title: string;
  description?: string;
  status?: 'pending' | 'completed';
};

export type QueueItemProps = ComponentProps<'li'>;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li
    className={cn(
      'group flex flex-col gap-1 rounded-md px-3 py-1 text-sm transition-colors hover:bg-muted',
      className,
    )}
    {...props}
  />
);

export type QueueItemIndicatorProps = ComponentProps<'span'> & {
  completed?: boolean;
};

export const QueueItemIndicator = ({
  completed = false,
  className,
  ...props
}: QueueItemIndicatorProps) => (
  <span
    className={cn(
      'mt-0.5 inline-block size-2.5 rounded-full border',
      completed
        ? 'border-muted-foreground/20 bg-muted-foreground/10'
        : 'border-muted-foreground/50',
      className,
    )}
    {...props}
  />
```

### components/ai-elements/inline-citation.tsx
```
'use client';

import { Badge } from '@/components/ui/badge';
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from '@/components/ui/carousel';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

export type InlineCitationProps = ComponentProps<'span'>;

export const InlineCitation = ({ className, ...props }: InlineCitationProps) => (
  <span className={cn('group inline items-center gap-1', className)} {...props} />
);

export type InlineCitationTextProps = ComponentProps<'span'>;

export const InlineCitationText = ({ className, ...props }: InlineCitationTextProps) => (
  <span className={cn('transition-colors group-hover:bg-accent', className)} {...props} />
);

export type InlineCitationCardProps = ComponentProps<typeof HoverCard>;

export const InlineCitationCard = (props: InlineCitationCardProps) => (
  <HoverCard closeDelay={0} openDelay={0} {...props} />
);

export type InlineCitationCardTriggerProps = ComponentProps<typeof Badge> & {
  sources: string[];
};

export const InlineCitationCardTrigger = ({
  sources,
  className,
  ...props
}: InlineCitationCardTriggerProps) => (
  <HoverCardTrigger asChild>
    <Badge className={cn('ml-1 rounded-full', className)} variant="secondary" {...props}>
      {sources[0] ? (
        <>
          {new URL(sources[0]).hostname} {sources.length > 1 && `+${sources.length - 1}`}
        </>
      ) : (
        'unknown'
      )}
    </Badge>
  </HoverCardTrigger>
);
```

### components/ai-elements/controls.tsx
```
'use client';

import { cn } from '@/lib/utils';
import { Controls as ControlsPrimitive } from '@xyflow/react';
import type { ComponentProps } from 'react';

export type ControlsProps = ComponentProps<typeof ControlsPrimitive>;

export const Controls = ({ className, ...props }: ControlsProps) => (
  <ControlsPrimitive
    className={cn(
      'gap-px overflow-hidden rounded-md border bg-card p-1 shadow-none!',
      '[&>button]:rounded-md [&>button]:border-none! [&>button]:bg-transparent! [&>button]:hover:bg-secondary!',
      className,
    )}
    {...props}
  />
);
```

### components/slide-renderer/Editor/LaserOverlay.tsx
```
'use client';

import { motion } from 'motion/react';
import type { PercentageGeometry } from '@/lib/types/action';

interface LaserOverlayProps {
  geometry: PercentageGeometry;
  color?: string;
  duration?: number;
}

/**
 * Laser pointer overlay component
 *
 * Features:
 * - Smoothly flies in from the nearest corner to the element center
 * - Elegant light dot with soft breathing glow
 * - Uses percentage positioning (0-100)
 */
export function LaserOverlay({
  geometry,
  color = '#ff3b30',
  duration: _duration = 3000,
}: LaserOverlayProps) {
  const { centerX, centerY } = geometry;

  const startPos = {
    x: centerX > 50 ? 105 : -5,
    y: centerY > 50 ? 105 : -5,
  };

  return (
    <motion.div
      key={`laser-${centerX}-${centerY}`}
      initial={{
        opacity: 0,
        left: `${startPos.x}%`,
        top: `${startPos.y}%`,
      }}
      animate={{
        opacity: 1,
        left: `${centerX}%`,
        top: `${centerY}%`,
      }}
      exit={{
        opacity: 0,
        left: `${startPos.x}%`,
        top: `${startPos.y}%`,
        transition: { duration: 0.25, ease: [0.4, 0, 1, 1] },
      }}
      transition={{
        left: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
        top: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
        opacity: { duration: 0.15 },
      }}
      className="absolute z-[101] pointer-events-none"
    >
      <div className="relative -translate-x-1/2 -translate-y-1/2">
        {/* Ring pulse */}
        <motion.div
```

### components/slide-renderer/Editor/ScreenElement.tsx
```
'use client';

import { ElementTypes, type PPTElement } from '@/lib/types/slides';
import { useMemo } from 'react';

import { BaseImageElement } from '../components/element/ImageElement/BaseImageElement';
import { BaseTextElement } from '../components/element/TextElement/BaseTextElement';
import { BaseShapeElement } from '../components/element/ShapeElement/BaseShapeElement';
import { BaseLineElement } from '../components/element/LineElement/BaseLineElement';
import { BaseChartElement } from '../components/element/ChartElement/BaseChartElement';
import { BaseLatexElement } from '../components/element/LatexElement/BaseLatexElement';
import { BaseTableElement } from '../components/element/TableElement/BaseTableElement';
import { BaseVideoElement } from '../components/element/VideoElement/BaseVideoElement';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import type { SceneContent } from '@/lib/types/stage';

interface ScreenElementProps {
  readonly elementInfo: PPTElement;
  readonly elementIndex: number;
  readonly animate?: boolean;
}

export function ScreenElement({ elementInfo, elementIndex, animate }: ScreenElementProps) {
  const CurrentElementComponent = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- element components have varying prop signatures
    const elementTypeMap: Record<string, any> = {
      [ElementTypes.IMAGE]: BaseImageElement,
      [ElementTypes.TEXT]: BaseTextElement,
      [ElementTypes.SHAPE]: BaseShapeElement,
      [ElementTypes.LINE]: BaseLineElement,
      [ElementTypes.CHART]: BaseChartElement,
      [ElementTypes.LATEX]: BaseLatexElement,
      [ElementTypes.TABLE]: BaseTableElement,
      [ElementTypes.VIDEO]: BaseVideoElement,
      // TODO: Add other element types
      // [ElementTypes.AUDIO]: BaseAudioElement,
    };
    return elementTypeMap[elementInfo.type] || null;
  }, [elementInfo.type]);

  const theme = useSceneSelector<SceneContent, { fontColor: string; fontName: string }>(
    (content) => {
      if (content.type === 'slide') {
        return content.canvas.theme;
      }
      return {
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
      };
    },
  );

  if (!CurrentElementComponent) {
    return null;
  }

  return (
    <div
      className="screen-element"
      id={`screen-element-${elementInfo.id}`}
```

### components/slide-renderer/Editor/HighlightOverlay.tsx
```
'use client';

import { useMemo } from 'react';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useCanvasStore } from '@/lib/store/canvas';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement } from '@/lib/types/slides';

/**
 * Highlight overlay component
 *
 * Features:
 * - Overlays highlight effects on top of elements
 * - Does not modify element properties
 * - Supports highlighting multiple elements simultaneously
 * - Supports animation effects (breathing, blinking, etc.)
 *
 * Implementation:
 * - Creates overlay divs at element positions
 * - Uses box-shadow for glow effects
 * - Uses CSS animation for animated effects
 */
export function HighlightOverlay() {
  const highlightedElementIds = useCanvasStore.use.highlightedElementIds();
  const highlightOptions = useCanvasStore.use.highlightOptions();

  // Get the element list of the current scene
  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );

  // Find all elements to highlight (exclude line elements as they have no height property)
  const highlightedElements = useMemo(() => {
    if (!highlightedElementIds.length) return [];
    return elements.filter((el) => highlightedElementIds.includes(el.id) && el.type !== 'line');
  }, [elements, highlightedElementIds]);

  // Skip rendering if no highlighted elements
  if (!highlightedElements.length || !highlightOptions) {
    return null;
  }

  const { color = '#ff6b6b', opacity = 0.3, borderWidth = 3, animated = true } = highlightOptions;

  return (
    <>
      {highlightedElements.map((element) => {
        // Type guard: line elements are already filtered out above
        // Use 'in' operator for runtime checks to satisfy TypeScript
        const height = 'height' in element ? element.height : 0;
        const rotate = 'rotate' in element ? element.rotate : 0;
        return (
          <div
            key={element.id}
            className="highlight-overlay absolute pointer-events-none"
            style={{
              left: `${element.left}px`,
              top: `${element.top}px`,
              width: `${element.width}px`,
              height: `${height}px`,
```

### components/slide-renderer/Editor/index.tsx
```
'use client';

import Canvas from './Canvas';
import type { StageMode } from '@/lib/types/stage';
import { ScreenCanvas } from './ScreenCanvas';

/**
 * Slide Editor - wraps Canvas with SceneProvider
 */
export function SlideEditor({ mode }: { readonly mode: StageMode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        {mode === 'autonomous' ? <Canvas /> : <ScreenCanvas />}
      </div>
    </div>
  );
}
```

### components/slide-renderer/Editor/ZoomWrapper.tsx
```
'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { PercentageGeometry } from '@/lib/types/action';

interface ZoomWrapperProps {
  children: ReactNode;
  zoomTarget: { elementId: string; scale: number } | null;
  geometry: PercentageGeometry | null;
}

/**
 * 缩放包装器组件
 *
 * 功能：
 * - 包裹整个画布，根据 zoomTarget 进行缩放
 * - 以元素中心为缩放原点
 * - 使用百分比坐标系统
 */
export function ZoomWrapper({ children, zoomTarget, geometry }: ZoomWrapperProps) {
  if (!zoomTarget || !geometry) {
    return <>{children}</>;
  }

  const { scale } = zoomTarget;
  const { centerX, centerY } = geometry;

  return (
    <motion.div
      className="w-full h-full"
      initial={{ scale: 1 }}
      animate={{ scale }}
      exit={{ scale: 1 }}
      transition={{
        type: 'spring',
        stiffness: 200,
        damping: 25,
      }}
      style={{
        transformOrigin: `${centerX}% ${centerY}%`,
      }}
    >
      {children}
    </motion.div>
  );
}
```

### components/slide-renderer/Editor/SpotlightOverlay.tsx
```
'use client';

import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useCanvasStore } from '@/lib/store/canvas';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement } from '@/lib/types/slides';

interface SpotlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Spotlight overlay component
 *
 * Uses DOM measurement (getBoundingClientRect) to compute spotlight position,
 * avoiding alignment offsets from percentage coordinate conversion.
 */
export function SpotlightOverlay() {
  const spotlightElementId = useCanvasStore.use.spotlightElementId();
  const spotlightOptions = useCanvasStore.use.spotlightOptions();
  const containerRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<SpotlightRect | null>(null);

  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );

  // Compute target element position in SVG coordinate system via DOM measurement
  const measure = useCallback(() => {
    if (!spotlightElementId || !containerRef.current) {
      setRect(null);
      return;
    }

    const domElement = document.getElementById(`screen-element-${spotlightElementId}`);
    if (!domElement) {
      setRect(null);
      return;
    }

    // Prefer measuring .element-content (the actual rendered area for auto-height)
    const contentEl = domElement.querySelector('.element-content');
    const targetEl = contentEl ?? domElement;

    const containerRect = containerRef.current.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    if (containerRect.width === 0 || containerRect.height === 0) {
      setRect(null);
      return;
    }

    // Convert to SVG viewBox 0-100 coordinates
    setRect({
      x: ((targetRect.left - containerRect.left) / containerRect.width) * 100,
```

### components/slide-renderer/Editor/ScreenCanvas.tsx
```
'use client';

import { ScreenElement } from './ScreenElement';
import { HighlightOverlay } from './HighlightOverlay';
import { SpotlightOverlay } from './SpotlightOverlay';
import { LaserOverlay } from './LaserOverlay';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import { useCanvasStore } from '@/lib/store';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { findElementGeometry } from '@/lib/utils/geometry';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, SlideBackground } from '@/lib/types/slides';
import type { PercentageGeometry } from '@/lib/types/action';
import { useViewportSize } from './Canvas/hooks/useViewportSize';
import { useRef, useMemo } from 'react';
import { AnimatePresence } from 'motion/react';

export function ScreenCanvas() {
  const canvasScale = useCanvasStore.use.canvasScale();
  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );
  const canvasRef = useRef<HTMLDivElement>(null);

  // Viewport size and positioning
  const { viewportStyles } = useViewportSize(canvasRef);

  // Get background style
  const background = useSceneSelector<SlideContent, SlideBackground | undefined>(
    (content) => content.canvas.background,
  );
  const { backgroundStyle } = useSlideBackgroundStyle(background);

  // Get visual effect state
  const laserElementId = useCanvasStore.use.laserElementId();
  const laserOptions = useCanvasStore.use.laserOptions();
  const zoomTarget = useCanvasStore.use.zoomTarget();

  // Compute laser pointer geometry
  const laserGeometry = useMemo<PercentageGeometry | null>(() => {
    if (!laserElementId) return null;
    const element = elements.find((el) => el.id === laserElementId);
    if (!element) return null;
    return findElementGeometry(
      { type: 'slide', content: { canvas: { elements } } } as Record<string, unknown>,
      laserElementId,
    );
  }, [laserElementId, elements]);

  // Compute zoom target geometry
  const zoomGeometry = useMemo<PercentageGeometry | null>(() => {
    if (!zoomTarget) return null;
    const element = elements.find((el) => el.id === zoomTarget.elementId);
    if (!element) return null;
    return findElementGeometry(
      { type: 'slide', content: { canvas: { elements } } } as Record<string, unknown>,
      zoomTarget.elementId,
    );
  }, [zoomTarget, elements]);

```

### components/slide-renderer/components/element/ElementOutline.tsx
```
'use client';

import type { PPTElementOutline } from '@/lib/types/slides';
import { useElementOutline } from './hooks/useElementOutline';

export interface ElementOutlineProps {
  width: number;
  height: number;
  outline?: PPTElementOutline;
}

/**
 * Element outline (border) component
 * Renders an SVG outline around an element based on outline configuration
 */
export function ElementOutline({ width, height, outline }: ElementOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);

  if (!outline) return null;

  return (
    <svg
      className="element-outline absolute top-0 left-0 overflow-visible"
      width={width}
      height={height}
    >
      <path
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        d={`M0,0 L${width},0 L${width},${height} L0,${height} Z`}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}
```

### components/slide-renderer/components/element/ProsemirrorEditor.tsx
```
'use client';

import { useRef, useEffect, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { debounce } from 'lodash';
import { useKeyboardStore, useCanvasStore } from '@/lib/store';
import type { EditorView } from 'prosemirror-view';
import { toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { initProsemirrorEditor, createDocument } from '@/lib/prosemirror';
import {
  isActiveOfParentNodeType,
  findNodesWithSameMark,
  getTextAttrs,
  autoSelectAll,
  addMark,
  markActive,
  getFontsize,
} from '@/lib/prosemirror/utils';
import emitter, {
  EmitterEvents,
  type RichTextAction,
  type RichTextCommand,
} from '@/lib/utils/emitter';
import { alignmentCommand } from '@/lib/prosemirror/commands/setTextAlign';
import { indentCommand, textIndentCommand } from '@/lib/prosemirror/commands/setTextIndent';
import { toggleList } from '@/lib/prosemirror/commands/toggleList';
import { setListStyle } from '@/lib/prosemirror/commands/setListStyle';
import { replaceText } from '@/lib/prosemirror/commands/replaceText';
import type { TextFormatPainterKeys } from '@/lib/types/edit';
import { KEYS } from '@/configs/hotkey';
import { toast } from 'sonner';

export interface ProsemirrorEditorProps {
  elementId: string;
  defaultColor: string;
  defaultFontName: string;
  value: string;
  editable?: boolean;
  autoFocus?: boolean;
  onUpdate?: (payload: { value: string; ignore: boolean }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
}

export interface ProsemirrorEditorRef {
  focus: () => void;
}

/**
 * ProseMirror rich text Editor component
 * Handles complex text editing with support for formatting, lists, links, etc.
 */
export const ProsemirrorEditor = forwardRef<ProsemirrorEditorRef, ProsemirrorEditorProps>(
  (
    {
      elementId,
      defaultColor,
      defaultFontName,
      value,
      editable = false,
```

### components/slide-renderer/components/ThumbnailSlide/index.tsx
```
import { useMemo } from 'react';
import type { Slide } from '@/lib/types/slides';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import { ThumbnailElement } from './ThumbnailElement';

interface ThumbnailSlideProps {
  /** Slide data */
  readonly slide: Slide;
  /** Thumbnail width */
  readonly size: number;
  /** Viewport width base (default 1000px) */
  readonly viewportSize: number;
  /** Viewport aspect ratio (default 0.5625 i.e. 16:9) */
  readonly viewportRatio: number;
  /** Whether visible (for lazy loading optimization) */
  readonly visible?: boolean;
}

/**
 * Thumbnail slide component
 *
 * Renders a thumbnail preview of a single slide
 * Uses CSS transform scale to resize the entire view for better performance
 */
export function ThumbnailSlide({
  slide,
  size,
  viewportSize,
  viewportRatio,
  visible = true,
}: ThumbnailSlideProps) {
  // Calculate scale ratio
  const scale = useMemo(() => size / viewportSize, [size, viewportSize]);

  // Get background style
  const { backgroundStyle } = useSlideBackgroundStyle(slide.background);

  if (!visible) {
    return (
      <div
        className="thumbnail-slide bg-white overflow-hidden select-none"
        style={{
          width: `${size}px`,
          height: `${size * viewportRatio}px`,
        }}
      >
        <div className="placeholder w-full h-full flex justify-center items-center text-gray-400 text-sm">
          加载中 ...
        </div>
      </div>
    );
  }

  return (
    <div
      className="thumbnail-slide bg-white overflow-hidden select-none"
      style={{
        width: `${size}px`,
        height: `${size * viewportRatio}px`,
      }}
```

### components/slide-renderer/components/ThumbnailSlide/ThumbnailElement.tsx
```
import { useMemo } from 'react';
import { ElementTypes, type PPTElement } from '@/lib/types/slides';

import { BaseImageElement } from '../element/ImageElement/BaseImageElement';
import { BaseTextElement } from '../element/TextElement/BaseTextElement';
import { BaseShapeElement } from '../element/ShapeElement/BaseShapeElement';
import { BaseLineElement } from '../element/LineElement/BaseLineElement';
import { BaseChartElement } from '../element/ChartElement/BaseChartElement';
import { BaseLatexElement } from '../element/LatexElement/BaseLatexElement';
import { BaseTableElement } from '../element/TableElement/BaseTableElement';
import { BaseVideoElement } from '../element/VideoElement/BaseVideoElement';

interface ThumbnailElementProps {
  readonly elementInfo: PPTElement;
  readonly elementIndex: number;
}

/**
 * Thumbnail element component
 *
 * Renders the corresponding Base component based on element type
 */
export function ThumbnailElement({ elementInfo, elementIndex }: ThumbnailElementProps) {
  const CurrentElementComponent = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- element components have varying prop signatures
    const elementTypeMap: Record<string, any> = {
      [ElementTypes.IMAGE]: BaseImageElement,
      [ElementTypes.TEXT]: BaseTextElement,
      [ElementTypes.SHAPE]: BaseShapeElement,
      [ElementTypes.LINE]: BaseLineElement,
      [ElementTypes.CHART]: BaseChartElement,
      [ElementTypes.LATEX]: BaseLatexElement,
      [ElementTypes.TABLE]: BaseTableElement,
      // TODO: Add other element types
      [ElementTypes.VIDEO]: BaseVideoElement,
      // [ElementTypes.AUDIO]: BaseAudioElement,
    };
    return elementTypeMap[elementInfo.type] || null;
  }, [elementInfo.type]);

  if (!CurrentElementComponent) {
    return null;
  }

  return (
    <div
      className={`base-element base-element-${elementInfo.id}`}
      style={{
        zIndex: elementIndex,
      }}
    >
      <CurrentElementComponent elementInfo={elementInfo} target="thumbnail" />
    </div>
  );
}
```

### components/slide-renderer/components/element/ChartElement/BaseChartElement.tsx
```
'use client';

import type { PPTChartElement } from '@/lib/types/slides';
import { ElementOutline } from '../ElementOutline';
import { Chart } from './Chart';

export interface BaseChartElementProps {
  elementInfo: PPTChartElement;
  target?: string;
}

/**
 * Base chart element for read-only/playback mode
 */
export function BaseChartElement({ elementInfo, target }: BaseChartElementProps) {
  return (
    <div
      className={`base-element-chart absolute ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className="element-content w-full h-full"
          style={{
            backgroundColor: elementInfo.fill,
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <Chart
            width={elementInfo.width}
            height={elementInfo.height}
            type={elementInfo.chartType}
            data={elementInfo.data}
            themeColors={elementInfo.themeColors}
            textColor={elementInfo.textColor}
            lineColor={elementInfo.lineColor}
            options={elementInfo.options}
          />
        </div>
      </div>
    </div>
  );
}
```

### components/slide-renderer/components/element/ChartElement/index.tsx
```
'use client';

import type { PPTChartElement } from '@/lib/types/slides';
import { ElementOutline } from '../ElementOutline';
import { Chart } from './Chart';

export { BaseChartElement } from './BaseChartElement';

export interface ChartElementProps {
  elementInfo: PPTChartElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTChartElement) => void;
}

/**
 * Chart element component
 * Renders interactive charts using ECharts
 */
export function ChartElement({ elementInfo, selectElement }: ChartElementProps) {
  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  return (
    <div
      className={`editable-element-chart absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className={`element-content relative w-full h-full overflow-hidden ${
            elementInfo.lock ? 'cursor-default' : 'cursor-move'
          }`}
          style={{
            backgroundColor: elementInfo.fill,
          }}
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <Chart
            width={elementInfo.width}
            height={elementInfo.height}
            type={elementInfo.chartType}
            data={elementInfo.data}
            themeColors={elementInfo.themeColors}
            textColor={elementInfo.textColor}
```

### components/slide-renderer/components/element/ChartElement/Chart.tsx
```
'use client';

import { useEffect, useRef, useMemo } from 'react';
import tinycolor from 'tinycolor2';
import type { ChartData, ChartOptions, ChartType } from '@/lib/types/slides';
import { getChartOption } from './chartOption';

import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart, RadarChart } from 'echarts/charts';
import { LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  RadarChart,
  LegendComponent,
  SVGRenderer,
]);

interface ChartProps {
  width: number;
  height: number;
  type: ChartType;
  data: ChartData;
  themeColors: string[];
  textColor?: string;
  lineColor?: string;
  options?: ChartOptions;
}

export function Chart({
  width: _width,
  height: _height,
  type,
  data,
  themeColors: rawThemeColors,
  textColor,
  lineColor,
  options,
}: ChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  // Generate theme colors
  const themeColors = useMemo(() => {
    let colors: string[] = [];
    if (rawThemeColors.length >= 10) {
      colors = rawThemeColors;
    } else if (rawThemeColors.length === 1) {
      colors = tinycolor(rawThemeColors[0])
        .analogous(10)
        .map((color) => color.toRgbString());
    } else {
      const len = rawThemeColors.length;
      const supplement = tinycolor(rawThemeColors[len - 1])
        .analogous(10 + 1 - len)
        .map((color) => color.toRgbString());
```

### components/slide-renderer/components/element/ChartElement/chartOption.ts
```
import type { ComposeOption } from 'echarts/core';
import type {
  BarSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
  ScatterSeriesOption,
  RadarSeriesOption,
} from 'echarts/charts';
import type { ChartData, ChartType } from '@/lib/types/slides';

type EChartOption = ComposeOption<
  BarSeriesOption | LineSeriesOption | PieSeriesOption | ScatterSeriesOption | RadarSeriesOption
>;

export interface ChartOptionPayload {
  type: ChartType;
  data: ChartData;
  themeColors: string[];
  textColor?: string;
  lineColor?: string;
  lineSmooth?: boolean;
  stack?: boolean;
}

export const getChartOption = ({
  type,
  data,
  themeColors,
  textColor,
  lineColor,
  lineSmooth,
  stack,
}: ChartOptionPayload): EChartOption | null => {
  const textStyle = textColor
    ? {
        color: textColor,
      }
    : {};

  const axisLine = textColor
    ? {
        lineStyle: {
          color: textColor,
        },
      }
    : undefined;

  const axisLabel = textColor
    ? {
        color: textColor,
      }
    : undefined;

  const splitLine = lineColor
    ? {
        lineStyle: {
          color: lineColor,
        },
      }
    : {};
```

### components/slide-renderer/components/element/ShapeElement/BaseShapeElement.tsx
```
'use client';

import type { PPTShapeElement, ShapeText } from '@/lib/types/slides';
import { useElementOutline } from '../hooks/useElementOutline';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useElementFill } from '../hooks/useElementFill';
import { GradientDefs } from './GradientDefs';
import { PatternDefs } from './PatternDefs';

export interface BaseShapeElementProps {
  elementInfo: PPTShapeElement;
}

/**
 * Base shape element for read-only/playback mode
 */
export function BaseShapeElement({ elementInfo }: BaseShapeElementProps) {
  const { fill } = useElementFill(elementInfo, 'base');
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(elementInfo.outline);
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);

  const text: ShapeText = elementInfo.text || {
    content: '',
    align: 'middle',
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
  };

  return (
    <div
      className="base-element-shape absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className="element-content relative w-full h-full"
          style={{
            opacity: elementInfo.opacity,
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
            transform: flipStyle,
            color: text.defaultColor,
            fontFamily: text.defaultFontName,
          }}
        >
          <svg
            overflow="visible"
            width={elementInfo.width}
            height={elementInfo.height}
            className="transform-origin-[0_0] overflow-visible block"
          >
```

### components/slide-renderer/components/element/ShapeElement/index.tsx
```
'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';
import type { PPTShapeElement, ShapeText } from '@/lib/types/slides';
import { useCanvasStore } from '@/lib/store';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useElementFill } from '../hooks/useElementFill';
import { useElementOutline } from '../hooks/useElementOutline';
import { GradientDefs } from './GradientDefs';
import { PatternDefs } from './PatternDefs';
import { ProsemirrorEditor } from '../ProsemirrorEditor';

export { BaseShapeElement } from './BaseShapeElement';

export interface ShapeElementProps {
  elementInfo: PPTShapeElement;
  selectElement?: (
    e: React.MouseEvent | React.TouchEvent,
    element: PPTShapeElement,
    canMove?: boolean,
  ) => void;
}

/**
 * Shape element component with text editing support
 * Supports gradients, patterns, and rich text content
 */
export function ShapeElement({ elementInfo, selectElement }: ShapeElementProps) {
  const handleElementId = useCanvasStore.use.handleElementId();
  const { updateElement, removeElementProps } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { fill } = useElementFill(elementInfo, 'editable');
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(elementInfo.outline);

  const [editable, setEditable] = useState(false);

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent, canMove = true) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo, canMove);
  };

  // Stop editing when element is no longer active
  useEffect(() => {
    if (handleElementId !== elementInfo.id && editable) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync editable state with active element
      setEditable(false);
    }
  }, [handleElementId, elementInfo.id, editable]);

  // Default text configuration
  const text = useMemo<ShapeText>(() => {
    const defaultText: ShapeText = {
      content: '',
```

### components/slide-renderer/components/element/ShapeElement/PatternDefs.tsx
```
interface PatternDefsProps {
  id: string;
  src: string;
}

export function PatternDefs({ id, src }: PatternDefsProps) {
  return (
    <pattern
      id={id}
      patternContentUnits="objectBoundingBox"
      patternUnits="objectBoundingBox"
      width="1"
      height="1"
    >
      <image href={src} width="1" height="1" preserveAspectRatio="xMidYMid slice" />
    </pattern>
  );
}
```

### components/slide-renderer/components/element/ShapeElement/GradientDefs.tsx
```
import type { GradientColor, GradientType } from '@/lib/types/slides';

interface GradientDefsProps {
  id: string;
  type: GradientType;
  colors: GradientColor[];
  rotate?: number;
}

export function GradientDefs({ id, type, colors, rotate = 0 }: GradientDefsProps) {
  if (type === 'linear') {
    return (
      <linearGradient
        id={id}
        x1="0%"
        y1="0%"
        x2="100%"
        y2="0%"
        gradientTransform={`rotate(${rotate},0.5,0.5)`}
      >
        {colors.map((item, index) => (
          <stop key={index} offset={`${item.pos}%`} stopColor={item.color} />
        ))}
      </linearGradient>
    );
  }

  return (
    <radialGradient id={id}>
      {colors.map((item, index) => (
        <stop key={index} offset={`${item.pos}%`} stopColor={item.color} />
      ))}
    </radialGradient>
  );
}
```

### components/slide-renderer/components/element/VideoElement/index.tsx
```
'use client';

import type { PPTVideoElement } from '@/lib/types/slides';

export interface VideoElementProps {
  elementInfo: PPTVideoElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTVideoElement) => void;
}

/**
 * Editable video element component.
 * In edit mode, displays the poster/thumbnail with a play icon overlay.
 * Does NOT autoplay to avoid disrupting the editing experience.
 */
export function VideoElement({ elementInfo, selectElement }: VideoElementProps) {
  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  return (
    <div
      className={`editable-element-video absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className={`element-content w-full h-full relative ${elementInfo.lock ? '' : 'cursor-move'}`}
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          {elementInfo.poster ? (
            <img
              className="w-full h-full"
              style={{ objectFit: 'contain' }}
              src={elementInfo.poster}
              alt=""
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
            />
          ) : elementInfo.src ? (
            <video
              className="w-full h-full"
              style={{ objectFit: 'contain', pointerEvents: 'none' }}
              src={elementInfo.src}
              preload="metadata"
            />
          ) : (
            <div className="w-full h-full bg-black/10 rounded" />
          )}

```

### components/slide-renderer/components/element/VideoElement/BaseVideoElement.tsx
```
'use client';

import { useRef, useEffect } from 'react';
import { useAnimate } from 'motion/react';
import type { PPTVideoElement } from '@/lib/types/slides';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore, isMediaPlaceholder } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { RotateCcw, Film, ShieldAlert, VideoOff } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';

const log = createLogger('BaseVideoElement');

export interface BaseVideoElementProps {
  elementInfo: PPTVideoElement;
}

/**
 * Base video element component for read-only/presentation display.
 * Controlled exclusively by the canvas store via the play_video action.
 * Videos never autoplay — they wait for an explicit play_video action.
 */
export function BaseVideoElement({ elementInfo }: BaseVideoElementProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingVideoElementId = useCanvasStore.use.playingVideoElementId();
  const prevPlayingRef = useRef('');
  const [scope, animate] = useAnimate<HTMLDivElement>();

  // Only subscribe to media store when inside a classroom (stageId provided via context).
  const stageId = useMediaStageId();
  const isPlaceholder = !!stageId && isMediaPlaceholder(elementInfo.src);
  const task = useMediaGenerationStore((s) => {
    if (!isPlaceholder) return undefined;
    const t = s.tasks[elementInfo.src];
    if (t && t.stageId !== stageId) return undefined;
    return t;
  });
  const videoGenerationEnabled = useSettingsStore((s) => s.videoGenerationEnabled);
  const resolvedSrc = task?.status === 'done' && task.objectUrl ? task.objectUrl : elementInfo.src;
  const showDisabled = isPlaceholder && !task && !videoGenerationEnabled;
  const showSkeleton =
    isPlaceholder &&
    !showDisabled &&
    (!task || task.status === 'pending' || task.status === 'generating');
  const showError = isPlaceholder && task?.status === 'failed';
  const isReady = !isPlaceholder || task?.status === 'done';

  // Ensure video is paused on mount — prevents browser autoplay from user gesture context
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
    }
  }, []);

  useEffect(() => {
```

### components/slide-renderer/components/element/LatexElement/index.tsx
```
'use client';

import { useRef, useState, useLayoutEffect } from 'react';
import type { PPTLatexElement } from '@/lib/types/slides';

export { BaseLatexElement } from './BaseLatexElement';

export interface LatexElementProps {
  elementInfo: PPTLatexElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTLatexElement) => void;
}

/**
 * Latex element component (editable mode).
 * Renders KaTeX HTML if available, falls back to legacy SVG path.
 */
export function LatexElement({ elementInfo, selectElement }: LatexElementProps) {
  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  return (
    <div
      className={`editable-element-latex absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className={`element-content relative w-full h-full ${
            elementInfo.lock ? 'cursor-default' : 'cursor-move'
          }`}
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          {elementInfo.html ? (
            <KatexContent
              html={elementInfo.html}
              width={elementInfo.width}
              height={elementInfo.height}
            />
          ) : elementInfo.path && elementInfo.viewBox ? (
            <svg
              overflow="visible"
              width={elementInfo.width}
              height={elementInfo.height}
              stroke={elementInfo.color}
              strokeWidth={elementInfo.strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
```

### components/slide-renderer/components/element/LatexElement/BaseLatexElement.tsx
```
'use client';

import { useRef, useState, useLayoutEffect } from 'react';
import type { PPTLatexElement } from '@/lib/types/slides';

export interface BaseLatexElementProps {
  elementInfo: PPTLatexElement;
}

/**
 * Base latex element for read-only/playback mode.
 * Renders KaTeX HTML if available, falls back to legacy SVG path.
 */
export function BaseLatexElement({ elementInfo }: BaseLatexElementProps) {
  return (
    <div
      className="base-element-latex absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div className="element-content relative w-full h-full">
          {elementInfo.html ? (
            <KatexContent
              html={elementInfo.html}
              width={elementInfo.width}
              height={elementInfo.height}
              align={elementInfo.align}
            />
          ) : elementInfo.path && elementInfo.viewBox ? (
            <svg
              overflow="visible"
              width={elementInfo.width}
              height={elementInfo.height}
              stroke={elementInfo.color}
              strokeWidth={elementInfo.strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transform-origin-[0_0] overflow-visible"
            >
              <g
                transform={`scale(${elementInfo.width / elementInfo.viewBox[0]}, ${
                  elementInfo.height / elementInfo.viewBox[1]
                }) translate(0,0) matrix(1,0,0,1,0,0)`}
              >
                <path d={elementInfo.path} />
              </g>
            </svg>
          ) : null}
        </div>
      </div>
    </div>
```

### components/slide-renderer/components/element/ImageElement/BaseImageElement.tsx
```
'use client';

import type { PPTImageElement } from '@/lib/types/slides';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useClipImage } from './useClipImage';
import { useFilter } from './useFilter';
import { ImageOutline } from './ImageOutline';
import { useMediaGenerationStore, isMediaPlaceholder } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { RotateCcw, Paintbrush, ShieldAlert, ImageOff } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export interface BaseImageElementProps {
  elementInfo: PPTImageElement;
}

/**
 * Base image element component for read-only display
 */
export function BaseImageElement({ elementInfo }: BaseImageElementProps) {
  const { t } = useI18n();
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { clipShape, imgPosition } = useClipImage(elementInfo);
  const { filter } = useFilter(elementInfo.filters);

  // Only subscribe to media store when inside a classroom (stageId provided via context).
  // Homepage thumbnails have no stageId context → skip store to prevent cross-course contamination.
  const stageId = useMediaStageId();
  const isPlaceholder = !!stageId && isMediaPlaceholder(elementInfo.src);
  const task = useMediaGenerationStore((s) => {
    if (!isPlaceholder) return undefined;
    const t = s.tasks[elementInfo.src];
    // Only use task if it belongs to the current stage
    if (t && t.stageId !== stageId) return undefined;
    return t;
  });

  const imageGenerationEnabled = useSettingsStore((s) => s.imageGenerationEnabled);
  // Resolve actual src: use objectUrl from store if available, otherwise original src
  const resolvedSrc = task?.status === 'done' && task.objectUrl ? task.objectUrl : elementInfo.src;
  const showDisabled = isPlaceholder && !task && !imageGenerationEnabled;
  const showSkeleton =
    isPlaceholder &&
    !showDisabled &&
    (!task || task.status === 'pending' || task.status === 'generating');
  const showError = isPlaceholder && task?.status === 'failed';

  return (
    <div
      className="absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
```

### components/slide-renderer/components/element/ImageElement/useFilter.ts
```
import { useMemo } from 'react';
import type { ImageElementFilters } from '@/lib/types/slides';

/**
 * Calculate CSS filter string from image filters array
 * @param filters Array of image filters
 */
export function useFilter(filters?: ImageElementFilters) {
  const filter = useMemo(() => {
    if (!filters) return '';
    let filterStr = '';
    for (const f of Object.values(filters)) {
      filterStr += `${f.type}(${f.value}) `;
    }
    return filterStr.trim();
  }, [filters]);

  return {
    filter,
  };
}
```

### components/slide-renderer/components/element/ImageElement/index.tsx
```
'use client';

import type { PPTImageElement, ImageElementClip } from '@/lib/types/slides';
import type { ImageClipedEmitData } from '@/lib/types/edit';
import { useCanvasStore } from '@/lib/store';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useClipImage } from './useClipImage';
import { useFilter } from './useFilter';
import { ImageOutline } from './ImageOutline';
import { ImageClipHandler } from './ImageClipHandler';

export interface ImageElementProps {
  elementInfo: PPTImageElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTImageElement) => void;
}

/**
 * Image element component with interaction support
 */
export function ImageElement({ elementInfo, selectElement }: ImageElementProps) {
  const clipingImageElementId = useCanvasStore.use.clipingImageElementId();
  const setClipingImageElementId = useCanvasStore.use.setClipingImageElementId();
  const { updateElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { clipShape, imgPosition } = useClipImage(elementInfo);
  const { filter } = useFilter(elementInfo.filters);

  const isCliping = clipingImageElementId === elementInfo.id;

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  const handleClip = (data: ImageClipedEmitData | null) => {
    setClipingImageElementId('');

    if (!data) return;

    const { range, position } = data;
    const originClip: ImageElementClip = elementInfo.clip || {
      shape: 'rect',
      range: [
        [0, 0],
        [100, 100],
      ],
    };

    const left = elementInfo.left + position.left;
    const top = elementInfo.top + position.top;
    const width = elementInfo.width + position.width;
    const height = elementInfo.height + position.height;

```

### components/slide-renderer/components/element/ImageElement/useClipImage.ts
```
import { useMemo } from 'react';
import type { PPTImageElement } from '@/lib/types/slides';
import { CLIPPATHS, ClipPathTypes } from '@/configs/image-clip';

/**
 * Calculate image clip shape and position
 * @param element Image element
 */
export function useClipImage(element: PPTImageElement) {
  const clipShape = useMemo(() => {
    let _clipShape = CLIPPATHS.rect;

    if (element.clip) {
      const shape = element.clip.shape || ClipPathTypes.RECT;
      _clipShape = CLIPPATHS[shape];
    }
    if (_clipShape.radius !== undefined && element.radius) {
      _clipShape = {
        ..._clipShape,
        radius: `${element.radius}px`,
        style: `inset(0 round ${element.radius}px)`,
      };
    }

    return _clipShape;
  }, [element.clip, element.radius]);

  const imgPosition = useMemo(() => {
    if (!element.clip || !element.clip.range) {
      return {
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
      };
    }

    const [start, end] = element.clip.range;

    const widthScale = (end[0] - start[0]) / 100;
    const heightScale = (end[1] - start[1]) / 100;
    const left = start[0] / widthScale;
    const top = start[1] / heightScale;

    return {
      left: -left + '%',
      top: -top + '%',
      width: 100 / widthScale + '%',
      height: 100 / heightScale + '%',
    };
  }, [element.clip]);

  return {
    clipShape,
    imgPosition,
  };
}
```

### components/slide-renderer/components/element/ImageElement/ImageClipHandler.tsx
```
'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useKeyboardStore, useCanvasStore } from '@/lib/store';
import { KEYS } from '@/configs/hotkey';
import { OperateResizeHandlers } from '@/lib/types/edit';
import type { ImageClipedEmitData } from '@/lib/types/edit';
import type { ImageClipDataRange, ImageElementClip } from '@/lib/types/slides';

export interface ImageClipHandlerProps {
  src: string;
  clipPath: string;
  width: number;
  height: number;
  top: number;
  left: number;
  rotate: number;
  clipData?: ImageElementClip;
  onClip: (payload: ImageClipedEmitData | null) => void;
}

export function ImageClipHandler({
  src,
  clipPath,
  width,
  height,
  rotate,
  clipData,
  onClip,
}: ImageClipHandlerProps) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  const [clipWrapperPositionStyle, setClipWrapperPositionStyle] = useState({
    top: '0',
    left: '0',
  });
  const [isSettingClipRange, setIsSettingClipRange] = useState(false);
  const [currentRange, setCurrentRange] = useState<ImageClipDataRange | null>(null);
  // Top image container position and size (clip highlight area)
  const [topImgWrapperPosition, setTopImgWrapperPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  });

  const wrapperRef = useRef<HTMLDivElement>(null);

  // Get clip area info (clip area's width/height ratio relative to the original image and its position within it)
  const getClipDataTransformInfo = useCallback(() => {
    const [start, end] = clipData
      ? clipData.range
      : [
          [0, 0],
          [100, 100],
        ];

    const widthScale = (end[0] - start[0]) / 100;
    const heightScale = (end[1] - start[1]) / 100;
```

### components/slide-renderer/components/element/LineElement/BaseLineElement.tsx
```
'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import type { PPTLineElement } from '@/lib/types/slides';
import { getLineElementPath } from '@/lib/utils/element';
import { useElementShadow } from '../hooks/useElementShadow';
import { LinePointMarker } from './LinePointMarker';

export interface BaseLineElementProps {
  elementInfo: PPTLineElement;
  animate?: boolean;
}

/** Duration of the stroke-drawing animation in ms */
const DRAW_ANIMATION_MS = 600;

/**
 * Base line element for read-only/playback mode.
 * When animate=true, plays a stroke-drawing animation on mount.
 */
export function BaseLineElement({ elementInfo, animate }: BaseLineElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const pathRef = useRef<SVGPathElement>(null);
  const [drawComplete, setDrawComplete] = useState(!animate);

  const svgWidth = useMemo(() => {
    const width = Math.abs(elementInfo.start[0] - elementInfo.end[0]);
    return width < 24 ? 24 : width;
  }, [elementInfo.start, elementInfo.end]);

  const svgHeight = useMemo(() => {
    const height = Math.abs(elementInfo.start[1] - elementInfo.end[1]);
    return height < 24 ? 24 : height;
  }, [elementInfo.start, elementInfo.end]);

  const lineDashArray = useMemo(() => {
    const size = elementInfo.width;
    if (elementInfo.style === 'dashed')
      return size <= 8 ? `${size * 5} ${size * 2.5}` : `${size * 5} ${size * 1.5}`;
    if (elementInfo.style === 'dotted')
      return size <= 8 ? `${size * 1.8} ${size * 1.6}` : `${size * 1.5} ${size * 1.2}`;
    return '0 0';
  }, [elementInfo.width, elementInfo.style]);

  const path = useMemo(() => {
    return getLineElementPath(elementInfo);
  }, [elementInfo]);

  // Stroke-drawing animation on mount (whiteboard only)
  useEffect(() => {
    if (!animate) return;
    const pathEl = pathRef.current;
    if (!pathEl) return;

    const length = pathEl.getTotalLength();
    if (length === 0) {
      // Zero-length path — skip animation, reveal markers on next tick
      const t = setTimeout(() => setDrawComplete(true), 0);
      return () => clearTimeout(t);
    }
```

### components/slide-renderer/components/element/LineElement/index.tsx
```
'use client';

import { useMemo } from 'react';
import type { PPTLineElement } from '@/lib/types/slides';
import { getLineElementPath } from '@/lib/utils/element';
import { useElementShadow } from '../hooks/useElementShadow';
import { LinePointMarker } from './LinePointMarker';

export { BaseLineElement } from './BaseLineElement';

export interface LineElementProps {
  elementInfo: PPTLineElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTLineElement) => void;
}

/**
 * Line element component
 * Renders SVG lines with optional arrow/dot endpoints
 */
export function LineElement({ elementInfo, selectElement }: LineElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  // Calculate SVG dimensions
  const svgWidth = useMemo(() => {
    const width = Math.abs(elementInfo.start[0] - elementInfo.end[0]);
    return width < 24 ? 24 : width;
  }, [elementInfo.start, elementInfo.end]);

  const svgHeight = useMemo(() => {
    const height = Math.abs(elementInfo.start[1] - elementInfo.end[1]);
    return height < 24 ? 24 : height;
  }, [elementInfo.start, elementInfo.end]);

  // Calculate line dash array for dashed/dotted styles
  const lineDashArray = useMemo(() => {
    const size = elementInfo.width;
    if (elementInfo.style === 'dashed') {
      return size <= 8 ? `${size * 5} ${size * 2.5}` : `${size * 5} ${size * 1.5}`;
    }
    if (elementInfo.style === 'dotted') {
      return size <= 8 ? `${size * 1.8} ${size * 1.6}` : `${size * 1.5} ${size * 1.2}`;
    }
    return '0 0';
  }, [elementInfo.width, elementInfo.style]);

  // Generate path data
  const path = useMemo(() => {
    return getLineElementPath(elementInfo);
  }, [elementInfo]);

  return (
    <div
      className={`editable-element-line absolute pointer-events-none ${elementInfo.lock ? 'lock' : ''}`}
      style={{
```

### components/slide-renderer/components/element/LineElement/LinePointMarker.tsx
```
import type { LinePoint } from '@/lib/types/slides';

type NonEmptyLinePoint = Exclude<LinePoint, ''>;

interface LinePointMarkerProps {
  id: string;
  position: 'start' | 'end';
  type: NonEmptyLinePoint;
  baseSize: number;
  color?: string;
}

const pathMap: Record<NonEmptyLinePoint, string> = {
  dot: 'm0 5a5 5 0 1 0 10 0a5 5 0 1 0 -10 0z',
  arrow: 'M0,0 L10,5 0,10 Z',
};

const rotateMap: Record<string, number> = {
  'arrow-start': 180,
  'arrow-end': 0,
};

export function LinePointMarker({ id, position, type, baseSize, color }: LinePointMarkerProps) {
  const path = pathMap[type];
  const rotate = rotateMap[`${type}-${position}`] || 0;
  const size = baseSize < 2 ? 2 : baseSize;

  return (
    <marker
      id={`${id}-${type}-${position}`}
      markerUnits="userSpaceOnUse"
      orient="auto"
      markerWidth={size * 3}
      markerHeight={size * 3}
      refX={size * 1.5}
      refY={size * 1.5}
    >
      <path
        d={path}
        fill={color}
        transform={`scale(${size * 0.3}, ${size * 0.3}) rotate(${rotate}, 5, 5)`}
      />
    </marker>
  );
}
```

### components/slide-renderer/components/element/TextElement/BaseTextElement.tsx
```
'use client';

import type { PPTTextElement } from '@/lib/types/slides';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
}

/**
 * Base text element component (read-only)
 * Renders static text content with styling
 */
export function BaseTextElement({ elementInfo, target }: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  return (
    <div
      className="base-element-text absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className="element-content relative p-[10px] leading-[1.5] break-words"
          style={{
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            height: elementInfo.vertical ? `${elementInfo.height}px` : 'auto',
            backgroundColor: elementInfo.fill,
            opacity: elementInfo.opacity,
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing: `${elementInfo.wordSpace || 0}px`,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            // @ts-expect-error - CSS custom property
            '--paragraphSpace': `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <div
            className={`text ProseMirror-static relative ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
            dangerouslySetInnerHTML={{ __html: elementInfo.content }}
          />
        </div>
      </div>
```

### components/slide-renderer/components/element/TextElement/index.tsx
```
'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { debounce } from 'lodash';
import { useCanvasStore } from '@/lib/store';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import type { PPTTextElement } from '@/lib/types/slides';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';
import { ProsemirrorEditor } from '../ProsemirrorEditor';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

export interface TextElementProps {
  elementInfo: PPTTextElement;
  selectElement?: (
    e: React.MouseEvent | React.TouchEvent,
    element: PPTTextElement,
    canMove?: boolean,
  ) => void;
}

/**
 * Editable text element component
 * Includes auto-height adjustment and empty text cleanup
 */
export function TextElement({ elementInfo, selectElement }: TextElementProps) {
  const handleElementId = useCanvasStore.use.handleElementId();
  const isScaling = useCanvasStore.use.isScaling();
  const { updateElement, deleteElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  const elementRef = useRef<HTMLDivElement>(null);
  const [realHeightCache, setRealHeightCache] = useState(-1);
  const [realWidthCache, setRealWidthCache] = useState(-1);

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent, canMove = true) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo, canMove);
  };

  // Check if element is being handled
  const isHandleElement = handleElementId === elementInfo.id;

  // Update element height/width when scaling ends
  useEffect(() => {
    if (handleElementId !== elementInfo.id) return;

    if (!isScaling) {
      if (!elementInfo.vertical && realHeightCache !== -1) {
        updateElement({
          id: elementInfo.id,
          props: { height: realHeightCache },
        });
        // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement requires effect
        setRealHeightCache(-1);
      }
      if (elementInfo.vertical && realWidthCache !== -1) {
```

### components/slide-renderer/components/element/TableElement/StaticTable.tsx
```
'use client';

import { useMemo } from 'react';
import type { PPTTableElement } from '@/lib/types/slides';
import { getTableSubThemeColor } from '@/lib/utils/element';
import { getTextStyle, formatText, getHiddenCells } from './tableUtils';

interface StaticTableProps {
  elementInfo: PPTTableElement;
}

/**
 * Static table rendering component, ported from PPTist StaticTable.vue.
 * Renders table data with theme colors, outline borders, and merged cells.
 */
export function StaticTable({ elementInfo }: StaticTableProps) {
  const { width, data, colWidths, cellMinHeight, outline, theme } = elementInfo;

  const hiddenCells = useMemo(() => getHiddenCells(data), [data]);

  const [subThemeDark, subThemeLight] = useMemo(() => {
    if (!theme) return ['', ''];
    return getTableSubThemeColor(theme.color);
  }, [theme]);

  const borderStyle = useMemo(() => {
    if (!outline) return 'none';
    const w = outline.width ?? 1;
    const c = outline.color ?? '#000';
    const s = outline.style === 'dashed' ? 'dashed' : 'solid';
    return `${w}px ${s} ${c}`;
  }, [outline]);

  /**
   * Get background color for a cell based on theme and position
   */
  const getCellBg = (
    rowIdx: number,
    colIdx: number,
    cellBackcolor?: string,
  ): string | undefined => {
    if (cellBackcolor) return cellBackcolor;
    if (!theme) return undefined;

    const rowCount = data.length;
    const colCount = data[0]?.length ?? 0;

    // Row header (first row) gets theme color
    if (theme.rowHeader && rowIdx === 0) return theme.color;
    // Row footer (last row) gets theme color
    if (theme.rowFooter && rowIdx === rowCount - 1) return theme.color;
    // Col header (first col) gets dark sub-theme
    if (theme.colHeader && colIdx === 0) return subThemeDark;
    // Col footer (last col) gets dark sub-theme
    if (theme.colFooter && colIdx === colCount - 1) return subThemeDark;

    // Alternating row colors (skip header row for counting)
    const effectiveRow = theme.rowHeader ? rowIdx - 1 : rowIdx;
    if (effectiveRow >= 0 && effectiveRow % 2 === 0) return subThemeLight;

```

### components/slide-renderer/components/element/TableElement/index.tsx
```
'use client';

import type { PPTTableElement } from '@/lib/types/slides';
import { StaticTable } from './StaticTable';

export { BaseTableElement } from './BaseTableElement';

export interface TableElementProps {
  elementInfo: PPTTableElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTTableElement) => void;
}

/**
 * Editable table element component.
 * Supports selection/drag/resize via selectElement callback.
 * Cell editing is not implemented yet (display-only, matching ChartElement pattern).
 */
export function TableElement({ elementInfo, selectElement }: TableElementProps) {
  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  return (
    <div
      className={`editable-element-table absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className={`element-content relative w-full h-full overflow-hidden ${
            elementInfo.lock ? 'cursor-default' : 'cursor-move'
          }`}
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          <StaticTable elementInfo={elementInfo} />
        </div>
      </div>
    </div>
  );
}
```

### components/slide-renderer/components/element/TableElement/BaseTableElement.tsx
```
'use client';

import type { PPTTableElement } from '@/lib/types/slides';
import { StaticTable } from './StaticTable';

export interface BaseTableElementProps {
  elementInfo: PPTTableElement;
  target?: string;
}

/**
 * Base table element for read-only / playback / thumbnail mode
 */
export function BaseTableElement({ elementInfo, target }: BaseTableElementProps) {
  return (
    <div
      className={`base-element-table absolute ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div className="element-content w-full h-full">
          <StaticTable elementInfo={elementInfo} />
        </div>
      </div>
    </div>
  );
}
```

### components/slide-renderer/components/element/TableElement/tableUtils.ts
```
import type { CSSProperties } from 'react';
import type { TableCell, TableCellStyle } from '@/lib/types/slides';

/**
 * Convert TableCellStyle to CSS properties
 */
export function getTextStyle(style?: TableCellStyle): CSSProperties {
  if (!style) return {};

  const css: CSSProperties = {};

  if (style.bold) css.fontWeight = 'bold';
  if (style.em) css.fontStyle = 'italic';
  if (style.underline) css.textDecoration = 'underline';
  if (style.strikethrough) {
    css.textDecoration = css.textDecoration ? `${css.textDecoration} line-through` : 'line-through';
  }
  if (style.color) css.color = style.color;
  if (style.backcolor) css.backgroundColor = style.backcolor;
  if (style.fontsize) css.fontSize = style.fontsize;
  if (style.fontname) css.fontFamily = style.fontname;
  if (style.align) css.textAlign = style.align;

  return css;
}

/**
 * Format text: convert \n to <br/> and spaces to &nbsp;
 */
export function formatText(text: string): string {
  return text.replace(/\n/g, '<br/>').replace(/ /g, '&nbsp;');
}

/**
 * Compute hidden cell positions based on colspan/rowspan merges.
 * Returns a Set of "row_col" keys for cells that should be hidden.
 */
export function getHiddenCells(data: TableCell[][]): Set<string> {
  const hidden = new Set<string>();

  for (let rowIdx = 0; rowIdx < data.length; rowIdx++) {
    let realColIdx = 0;
    for (let colIdx = 0; colIdx < data[rowIdx].length; colIdx++) {
      // Skip positions already occupied by a previous merge
      while (hidden.has(`${rowIdx}_${realColIdx}`)) {
        realColIdx++;
      }

      const cell = data[rowIdx][colIdx];
      const colspan = cell.colspan ?? 1;
      const rowspan = cell.rowspan ?? 1;

      if (colspan > 1 || rowspan > 1) {
        for (let r = 0; r < rowspan; r++) {
          for (let c = 0; c < colspan; c++) {
            if (r === 0 && c === 0) continue;
            hidden.add(`${rowIdx + r}_${realColIdx + c}`);
          }
        }
      }
```

### components/slide-renderer/components/element/hooks/useElementOutline.ts
```
import { useMemo } from 'react';
import type { PPTElementOutline } from '@/lib/types/slides';

/**
 * Calculate element outline (border) styles
 * Handles default values and stroke dash array for dashed/dotted borders
 * @param outline Outline configuration
 */
export function useElementOutline(outline?: PPTElementOutline) {
  const outlineWidth = useMemo(() => outline?.width ?? 0, [outline?.width]);

  const outlineStyle = useMemo(() => outline?.style || 'solid', [outline?.style]);

  const outlineColor = useMemo(() => outline?.color || '#d14424', [outline?.color]);

  const strokeDashArray = useMemo(() => {
    const size = outlineWidth;
    if (outlineStyle === 'dashed')
      return size <= 6 ? `${size * 4.5} ${size * 2}` : `${size * 4} ${size * 1.5}`;
    if (outlineStyle === 'dotted')
      return size <= 6 ? `${size * 1.8} ${size * 1.6}` : `${size * 1.5} ${size * 1.2}`;
    return '0 0';
  }, [outlineWidth, outlineStyle]);

  return {
    outlineWidth,
    outlineStyle,
    outlineColor,
    strokeDashArray,
  };
}
```

### components/slide-renderer/components/element/hooks/useElementShadow.ts
```
import { useMemo } from 'react';
import type { PPTElementShadow } from '@/lib/types/slides';

/**
 * Calculate element shadow style
 * Converts shadow object to CSS box-shadow string
 * @param shadow Shadow configuration
 */
export function useElementShadow(shadow?: PPTElementShadow) {
  const shadowStyle = useMemo(() => {
    if (shadow) {
      const { h, v, blur, color } = shadow;
      return `${h}px ${v}px ${blur}px ${color}`;
    }
    return '';
  }, [shadow]);

  return {
    shadowStyle,
  };
}
```

### components/slide-renderer/components/element/hooks/useElementFlip.ts
```
import { useMemo } from 'react';

/**
 * Calculate element flip transform style
 * Handles horizontal and/or vertical flip
 * @param flipH Flip horizontally
 * @param flipV Flip vertically
 */
export function useElementFlip(flipH?: boolean, flipV?: boolean) {
  const flipStyle = useMemo(() => {
    let style = '';

    if (flipH && flipV) style = 'rotateX(180deg) rotateY(180deg)';
    else if (flipV) style = 'rotateX(180deg)';
    else if (flipH) style = 'rotateY(180deg)';

    return style;
  }, [flipH, flipV]);

  return {
    flipStyle,
  };
}
```

### components/slide-renderer/components/element/hooks/useElementFill.ts
```
import { useMemo } from 'react';
import type { PPTShapeElement } from '@/lib/types/slides';

/**
 * Calculate element fill style
 * Returns pattern/gradient URL or solid color fill
 * @param element Shape element
 * @param source Source identifier for pattern/gradient IDs
 */
export function useElementFill(element: PPTShapeElement, source: string) {
  const fill = useMemo(() => {
    if (element.pattern) return `url(#${source}-pattern-${element.id})`;
    if (element.gradient) return `url(#${source}-gradient-${element.id})`;
    return element.fill || 'none';
  }, [element.pattern, element.gradient, element.fill, element.id, source]);

  return {
    fill,
  };
}
```

### components/slide-renderer/components/element/ImageElement/ImageOutline/image-rect-outline.tsx
```
'use client';

import type { PPTElementOutline } from '@/lib/types/slides';
import { useElementOutline } from '../../hooks/useElementOutline';

export interface ImageRectOutlineProps {
  width: number;
  height: number;
  outline?: PPTElementOutline;
  radius?: string;
}

/**
 * Rectangle outline for image element
 */
export function ImageRectOutline({ width, height, outline, radius = '0' }: ImageRectOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);

  if (!outline) return null;

  return (
    <svg className="absolute top-0 left-0 z-[2] overflow-visible" width={width} height={height}>
      <rect
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        rx={radius}
        ry={radius}
        width={width}
        height={height}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}
```

### components/slide-renderer/components/element/ImageElement/ImageOutline/index.tsx
```
'use client';

import type { PPTImageElement } from '@/lib/types/slides';
import { useClipImage } from '../useClipImage';
import { ImageRectOutline } from './image-rect-outline';
import { ImageEllipseOutline } from './image-ellipse-outline';
import { ImagePolygonOutline } from './image-polygon-outline';

export interface ImageOutlineProps {
  elementInfo: PPTImageElement;
}

/**
 * Image outline dispatcher based on clip shape type
 */
export function ImageOutline({ elementInfo }: ImageOutlineProps) {
  const { clipShape } = useClipImage(elementInfo);

  return (
    <div className="image-outline">
      {clipShape.type === 'rect' && (
        <ImageRectOutline
          width={elementInfo.width}
          height={elementInfo.height}
          radius={clipShape.radius}
          outline={elementInfo.outline}
        />
      )}
      {clipShape.type === 'ellipse' && (
        <ImageEllipseOutline
          width={elementInfo.width}
          height={elementInfo.height}
          outline={elementInfo.outline}
        />
      )}
      {clipShape.type === 'polygon' && (
        <ImagePolygonOutline
          width={elementInfo.width}
          height={elementInfo.height}
          outline={elementInfo.outline}
          createPath={clipShape.createPath!}
        />
      )}
    </div>
  );
}
```

### components/slide-renderer/components/element/ImageElement/ImageOutline/image-ellipse-outline.tsx
```
'use client';

import type { PPTElementOutline } from '@/lib/types/slides';
import { useElementOutline } from '../../hooks/useElementOutline';

export interface ImageEllipseOutlineProps {
  width: number;
  height: number;
  outline?: PPTElementOutline;
}

/**
 * Ellipse outline for image element
 */
export function ImageEllipseOutline({ width, height, outline }: ImageEllipseOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);

  if (!outline) return null;

  return (
    <svg className="absolute top-0 left-0 z-[2] overflow-visible" width={width} height={height}>
      <ellipse
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        cx={width / 2}
        cy={height / 2}
        rx={width / 2}
        ry={height / 2}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}
```

### components/slide-renderer/components/element/ImageElement/ImageOutline/image-polygon-outline.tsx
```
'use client';

import type { PPTElementOutline } from '@/lib/types/slides';
import { useElementOutline } from '../../hooks/useElementOutline';

export interface ImagePolygonOutlineProps {
  width: number;
  height: number;
  createPath: (width: number, height: number) => string;
  outline?: PPTElementOutline;
}

/**
 * Polygon outline for image element
 */
export function ImagePolygonOutline({
  width,
  height,
  createPath,
  outline,
}: ImagePolygonOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);

  if (!outline) return null;

  return (
    <svg className="absolute top-0 left-0 z-[2] overflow-visible" width={width} height={height}>
      <path
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        d={createPath(width, height)}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}
```

### components/slide-renderer/Editor/Canvas/GridLines.tsx
```
import { useMemo } from 'react';
import { useCanvasStore, useSceneSelector } from '@/lib/store';
import type { SlideContent } from '@/lib/types/stage';
import type { SlideBackground } from '@/lib/types/slides';

export function GridLines() {
  const gridLineSize = useCanvasStore.use.gridLineSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();
  const viewportSize = useCanvasStore.use.viewportSize();

  const background = useSceneSelector<SlideContent, SlideBackground | undefined>(
    (content) => content.canvas.background,
  );

  // Calculate grid line color to avoid blending with background
  const gridColor = useMemo(() => {
    const bgColor = background?.color || '#fff';
    // Simplified version: choose black or white based on background brightness
    const isLight = bgColor === '#fff' || bgColor.startsWith('#f') || bgColor.startsWith('#e');
    const baseColor = isLight ? '0, 0, 0' : '255, 255, 255';
    return `rgba(${baseColor}, 0.5)`;
  }, [background]);

  // Grid path
  const path = useMemo(() => {
    const maxX = viewportSize;
    const maxY = viewportSize * viewportRatio;

    let p = '';
    for (let i = 0; i <= Math.floor(maxY / gridLineSize); i++) {
      p += `M0 ${i * gridLineSize} L${maxX} ${i * gridLineSize} `;
    }
    for (let i = 0; i <= Math.floor(maxX / gridLineSize); i++) {
      p += `M${i * gridLineSize} 0 L${i * gridLineSize} ${maxY} `;
    }
    return p;
  }, [viewportSize, viewportRatio, gridLineSize]);

  return (
    <svg
      className="grid-lines absolute inset-0 pointer-events-none z-40"
      width={viewportSize}
      height={viewportSize * viewportRatio}
      viewBox={`0 0 ${viewportSize} ${viewportSize * viewportRatio}`}
    >
      <path d={path} fill="none" stroke={gridColor} strokeWidth="1" strokeDasharray="5 5" />
    </svg>
  );
}
```

### components/slide-renderer/Editor/Canvas/Ruler.tsx
```
import { useMemo, useEffect, useState } from 'react';
import { useCanvasStore } from '@/lib/store';
import { getElementListRange } from '@/lib/utils/element';
import type { PPTElement } from '@/lib/types/slides';
import type { ViewportStyles } from './hooks/useViewportSize';

interface RulerProps {
  viewportStyles: ViewportStyles;
  elementList: PPTElement[];
}

export function Ruler({ viewportStyles, elementList }: RulerProps) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const viewportRatio = useCanvasStore.use.viewportRatio();
  const viewportSize = useCanvasStore.use.viewportSize();

  const [elementListRange, setElementListRange] = useState<ReturnType<
    typeof getElementListRange
  > | null>(null);

  useEffect(() => {
    const els = elementList.filter((el) => activeElementIdList.includes(el.id));
    if (!els.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement requires effect
      setElementListRange(null);
    } else {
      setElementListRange(getElementListRange(els));
    }
  }, [elementList, activeElementIdList]);

  const markerSize = useMemo(() => {
    return (viewportStyles.width * canvasScale) / (viewportSize / 100);
  }, [viewportStyles.width, canvasScale, viewportSize]);

  const markers = Array.from({ length: 20 }, (_, i) => i + 1);

  return (
    <div className="ruler text-xs">
      {/* Ruler corner */}
      <div
        className="corner absolute bg-white border border-gray-200 w-5 h-5"
        style={{
          left: viewportStyles.left - 25 + 'px',
          top: viewportStyles.top - 25 + 'px',
        }}
      />

      {/* Horizontal ruler */}
      <div
        className="h absolute bg-white border border-gray-200 h-5 flex justify-between items-center overflow-hidden"
        style={{
          width: viewportStyles.width * canvasScale + 'px',
          left: viewportStyles.left + 'px',
          top: viewportStyles.top - 25 + 'px',
        }}
      >
        {markers.map((marker) => (
          <div
            key={`h-marker-100-${marker}`}
```

### components/slide-renderer/Editor/Canvas/MouseSelection.tsx
```
'use client';

export interface MouseSelectionProps {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly quadrant: number;
  readonly canvasScale: number;
}

/**
 * Mouse selection component
 * Displays selection rectangle during mouse drag selection
 */
export function MouseSelection({
  top,
  left,
  width,
  height,
  quadrant,
  canvasScale,
}: MouseSelectionProps) {
  const selectionStyle = {
    left: `${(quadrant === 2 || quadrant === 3 ? left - width : left) * canvasScale}px`,
    top: `${(quadrant === 2 || quadrant === 1 ? top - height : top) * canvasScale}px`,
    width: `${width * canvasScale}px`,
    height: `${height * canvasScale}px`,
  };

  return (
    <div
      className="mouse-selection absolute border-2 border-primary border-dashed z-41"
      style={selectionStyle}
    />
  );
}
```

### components/slide-renderer/Editor/Canvas/index.tsx
```
'use client';

import { useRef, useState, useEffect } from 'react';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useKeyboardStore } from '@/lib/store/keyboard';
import { useViewportSize } from './hooks/useViewportSize';
import { useSelectElement } from './hooks/useSelectElement';
import { useDragElement } from './hooks/useDragElement';
import { useRotateElement } from './hooks/useRotateElement';
import { useMouseSelection } from './hooks/useMouseSelection';
import { useScaleElement } from './hooks/useScaleElement';
import { useDragLineElement } from './hooks/useDragLineElement';
import { useMoveShapeKeypoint } from './hooks/useMoveShapeKeypoint';
import { useInsertFromCreateSelection } from './hooks/useInsertFromCreateSelection';
import { useDrop } from './hooks/useDrop';
import { AlignmentLine } from './AlignmentLine';
import { MouseSelection } from './MouseSelection';
import { ViewportBackground } from './ViewportBackground';
import { EditableElement } from './EditableElement';
import { Operate } from './Operate';
import { MultiSelectOperate } from './Operate/MultiSelectOperate';
import { ElementCreateSelection } from './ElementCreateSelection';
import { ShapeCreateCanvas } from './ShapeCreateCanvas';
import { Ruler } from './Ruler';
import { GridLines } from './GridLines';
import type { PPTElement } from '@/lib/types/slides';
import type { AlignmentLineProps } from '@/lib/types/edit';
import type { ContextmenuItem } from './EditableElement';
import type { SlideContent } from '@/lib/types/stage';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuShortcut,
  ContextMenuItem,
} from '@/components/ui/context-menu';

export interface CanvasProps {
  editable?: boolean;
}

/**
 * Canvas component
 *
 * Architecture:
 * - Slide data (elements, background) → Scene Context (from stageStore)
 * - Local element list → useRef + useState (for drag/scale/rotate operations)
 * - Canvas UI state (selection, toolbar) → Canvas Store
 * - Keyboard state → Keyboard Store
 *
 * Usage:
 * <SceneProvider>
 *   <Canvas />
 * </SceneProvider>
```

### components/slide-renderer/Editor/Canvas/ElementCreateSelection.tsx
```
import { useState, useRef, useEffect, useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import { useKeyboardStore } from '@/lib/store/keyboard';
import type { CreateElementSelectionData } from '@/lib/types/edit';

interface ElementCreateSelectionProps {
  onCreated: (data: CreateElementSelectionData) => void;
}

export function ElementCreateSelection({ onCreated }: ElementCreateSelectionProps) {
  const creatingElement = useCanvasStore.use.creatingElement();
  const setCreatingElement = useCanvasStore.use.setCreatingElement();
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  const [start, setStart] = useState<[number, number]>();
  const [end, setEnd] = useState<[number, number]>();
  const selectionRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!selectionRef.current) return;
    const { x, y } = selectionRef.current.getBoundingClientRect();
    setOffset({ x, y });
  }, []);

  // Mouse drag to create element: determine position and size
  // Get the start and end positions of the selection range
  const createSelection = (e: React.MouseEvent) => {
    let isMouseDown = true;

    const startPageX = e.pageX;
    const startPageY = e.pageY;
    setStart([startPageX, startPageY]);

    const handleMouseMove = (e: MouseEvent) => {
      if (!creatingElement || !isMouseDown) return;

      let currentPageX = e.pageX;
      let currentPageY = e.pageY;

      // When Ctrl or Shift is held:
      // For non-line elements, lock aspect ratio; for line elements, lock to horizontal or vertical direction
      if (ctrlOrShiftKeyActive) {
        const moveX = currentPageX - startPageX;
        const moveY = currentPageY - startPageY;

        // Horizontal and vertical drag distances; use the larger one as the base for computing the other
        const absX = Math.abs(moveX);
        const absY = Math.abs(moveY);

        if (creatingElement.type === 'shape') {
          // Check if dragging in reverse direction: top-left to bottom-right is forward, everything else is reverse
          const isOpposite = (moveY > 0 && moveX < 0) || (moveY < 0 && moveX > 0);

          if (absX > absY) {
            currentPageY = isOpposite ? startPageY - moveX : startPageY + moveX;
          } else {
            currentPageX = isOpposite ? startPageX - moveY : startPageX + moveY;
          }
        } else if (creatingElement.type === 'line') {
```

### components/slide-renderer/Editor/Canvas/ShapeCreateCanvas.tsx
```
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useKeyboardStore } from '@/lib/store/keyboard';
import { useCanvasStore, useSceneSelector } from '@/lib/store';
import type { CreateCustomShapeData } from '@/lib/types/edit';
import type { SlideContent } from '@/lib/types/stage';
import type { SlideTheme } from '@/lib/types/slides';
import { toast } from 'sonner';

interface ShapeCreateCanvasProps {
  onCreated: (data: CreateCustomShapeData) => void;
}

export function ShapeCreateCanvas({ onCreated }: ShapeCreateCanvasProps) {
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());
  const setCreatingCustomShapeState = useCanvasStore.use.setCreatingCustomShapeState();
  const theme = useSceneSelector<SlideContent, SlideTheme>((content) => content.canvas.theme);

  const shapeCanvasRef = useRef<HTMLDivElement>(null);
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [mousePosition, setMousePosition] = useState<[number, number] | null>(null);
  const [points, setPoints] = useState<[number, number][]>([]);
  const [closed, setClosed] = useState(false);

  const close = useCallback(() => {
    setCreatingCustomShapeState(false);
  }, [setCreatingCustomShapeState]);

  const getCreateData = useCallback(
    (closeShape = true) => {
      const xList = points.map((item) => item[0]);
      const yList = points.map((item) => item[1]);
      const minX = Math.min(...xList);
      const minY = Math.min(...yList);
      const maxX = Math.max(...xList);
      const maxY = Math.max(...yList);

      const formatedPoints = points.map((point) => {
        return [point[0] - minX, point[1] - minY];
      });

      let pathStr = '';
      for (let i = 0; i < formatedPoints.length; i++) {
        const point = formatedPoints[i];
        if (i === 0) pathStr += `M ${point[0]} ${point[1]} `;
        else pathStr += `L ${point[0]} ${point[1]} `;
      }
      if (closeShape) pathStr += 'Z';

      const start: [number, number] = [minX + offset.x, minY + offset.y];
      const end: [number, number] = [maxX + offset.x, maxY + offset.y];
      const viewBox: [number, number] = [maxX - minX, maxY - minY];

      return {
        start,
        end,
        path: pathStr,
        viewBox,
      };
    },
```

### components/slide-renderer/Editor/Canvas/EditableElement.tsx
```
import { useMemo } from 'react';
import { ElementTypes, type PPTElement } from '@/lib/types/slides';
import { ImageElement } from '../../components/element/ImageElement';
import { TextElement } from '../../components/element/TextElement';
import { LineElement } from '../../components/element/LineElement';
import { ShapeElement } from '../../components/element/ShapeElement';
import { ChartElement } from '../../components/element/ChartElement';
import { LatexElement } from '../../components/element/LatexElement';
import { TableElement } from '../../components/element/TableElement';
import { VideoElement } from '../../components/element/VideoElement';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ElementOrderCommands, ElementAlignCommands } from '@/lib/types/edit';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

export interface ContextmenuItem {
  text?: string;
  subText?: string;
  divider?: boolean;
  disable?: boolean;
  hide?: boolean;
  children?: ContextmenuItem[];
  handler?: () => void;
}

interface EditableElementProps {
  readonly elementInfo: PPTElement;
  readonly elementIndex: number;
  readonly isMultiSelect: boolean;
  readonly selectElement: (
    e: React.MouseEvent | React.TouchEvent,
    element: PPTElement,
    canMove?: boolean,
  ) => void;
  readonly openLinkDialog: () => void;
}

export function EditableElement({
  elementInfo,
  elementIndex,
  isMultiSelect,
  selectElement,
  openLinkDialog,
}: EditableElementProps) {
  const CurrentElementComponent = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- element components have varying prop signatures
    const elementTypeMap: Record<string, any> = {
      [ElementTypes.IMAGE]: ImageElement,
      [ElementTypes.TEXT]: TextElement,
      [ElementTypes.SHAPE]: ShapeElement,
      [ElementTypes.LINE]: LineElement,
```

### components/slide-renderer/Editor/Canvas/AlignmentLine.tsx
```
'use client';

import type { AlignmentLineProps } from '@/lib/types/edit';

export interface AlignmentLineComponentProps extends AlignmentLineProps {
  canvasScale: number;
}

/**
 * Alignment line component
 * Displays visual alignment guides during element dragging
 */
export function AlignmentLine({ type, axis, length, canvasScale }: AlignmentLineComponentProps) {
  // Alignment line position
  const left = axis.x * canvasScale;
  const top = axis.y * canvasScale;

  // Alignment line length
  const sizeStyle =
    type === 'vertical'
      ? { height: `${length * canvasScale}px` }
      : { width: `${length * canvasScale}px` };

  return (
    <div
      className="alignment-line absolute z-42"
      style={{
        left: `${left}px`,
        top: `${top}px`,
      }}
    >
      <div
        className={`line ${type === 'vertical' ? 'border-l border-dashed border-primary -translate-x-0.5' : 'border-t border-dashed border-primary -translate-y-0.5'}`}
        style={sizeStyle}
      />
    </div>
  );
}
```

### components/slide-renderer/Editor/Canvas/ViewportBackground.tsx
```
'use client';

import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import type { SlideContent } from '@/lib/types/stage';
import type { SlideBackground } from '@/lib/types/slides';

/**
 * Viewport background component using Scene Context
 * Renders the slide background from current scene data
 */
export function ViewportBackground() {
  // Subscribe only to background for performance
  const background = useSceneSelector<SlideContent, SlideBackground | undefined>(
    (content) => content.canvas.background,
  );

  const { backgroundStyle: bgStyle } = useSlideBackgroundStyle(background);

  const backgroundStyle: React.CSSProperties = {
    ...bgStyle,
    width: '100%',
    height: '100%',
    backgroundPosition: 'center',
    position: 'absolute',
    pointerEvents: 'none', // Don't block mouse events
  };

  return <div className="viewport-background" style={backgroundStyle} />;
}
```

### components/slide-renderer/Editor/Canvas/Operate/TableElementOperate.tsx
```
import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTTableElement } from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface TableElementOperateProps {
  readonly elementInfo: PPTTableElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTTableElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTTableElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function TableElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: TableElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const outlineWidth = useMemo(() => elementInfo.outline.width || 1, [elementInfo.outline.width]);

  const scaleWidth = useMemo(
    () => (elementInfo.width + outlineWidth) * canvasScale,
    [elementInfo.width, outlineWidth, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );

  const { resizeHandlers, borderLines } = useCommonOperate(scaleWidth, scaleHeight);

  return (
    <div className="table-element-operate">
      {borderLines.map((line) => (
        <BorderLine
          key={line.type}
          type={line.type}
          style={line.style}
          className="operate-border-line"
        />
      ))}
      {handlerVisible && (
        <>
          {resizeHandlers.map((point) => (
            <ResizeHandler
              key={point.direction}
              type={point.direction}
              rotate={elementInfo.rotate}
              style={point.style}
              className="operate-resize-handler"
```

### components/slide-renderer/Editor/Canvas/Operate/ShapeElementOperate.tsx
```
import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTShapeElement } from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface ShapeElementOperateProps {
  readonly elementInfo: PPTShapeElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTShapeElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTShapeElement,
    command: OperateResizeHandlers,
  ) => void;
  readonly moveShapeKeypoint: (
    e: React.MouseEvent,
    element: PPTShapeElement,
    index: number,
  ) => void;
}

export function ShapeElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
  moveShapeKeypoint,
}: ShapeElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const scaleWidth = useMemo(
    () => elementInfo.width * canvasScale,
    [elementInfo.width, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );
  const { resizeHandlers, borderLines } = useCommonOperate(scaleWidth, scaleHeight);

  const keypoints = useMemo(() => {
    if (!elementInfo.pathFormula || elementInfo.keypoints === undefined) return [];
    const pathFormula = SHAPE_PATH_FORMULAS[elementInfo.pathFormula];

    return elementInfo.keypoints.map((keypoint, index) => {
      const getBaseSize = pathFormula.getBaseSize![index];
      const relative = pathFormula.relative![index];
      const keypointPos = getBaseSize(elementInfo.width, elementInfo.height) * keypoint;

      let styles: React.CSSProperties = {};
      if (relative === 'left') styles = { left: keypointPos * canvasScale + 'px' };
      else if (relative === 'right')
        styles = {
          left: (elementInfo.width - keypointPos) * canvasScale + 'px',
        };
```

### components/slide-renderer/Editor/Canvas/Operate/index.tsx
```
import { useMemo } from 'react';
import { useCanvasStore, useSceneSelector } from '@/lib/store';
import {
  ElementTypes,
  type PPTElement,
  type PPTLineElement,
  type PPTVideoElement,
  type PPTAudioElement,
  type PPTShapeElement,
  type PPTChartElement,
  type Slide,
  type PPTAnimation,
} from '@/lib/types/slides';
import type { OperateLineHandlers, OperateResizeHandlers } from '@/lib/types/edit';
import { ImageElementOperate } from './ImageElementOperate';
import { TextElementOperate } from './TextElementOperate';
import { ShapeElementOperate } from './ShapeElementOperate';
import { LineElementOperate } from './LineElementOperate';
import { TableElementOperate } from './TableElementOperate';
import { CommonElementOperate } from './CommonElementOperate';
import type { SlideContent } from '@/lib/types/stage';

interface OperateProps {
  readonly elementInfo: PPTElement;
  readonly isSelected: boolean;
  readonly isActive: boolean;
  readonly isActiveGroupElement: boolean;
  readonly isMultiSelect: boolean;
  readonly rotateElement: (
    e: React.MouseEvent,
    element: Exclude<
      PPTElement,
      PPTChartElement | PPTLineElement | PPTVideoElement | PPTAudioElement
    >,
  ) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: Exclude<PPTElement, PPTLineElement>,
    command: OperateResizeHandlers,
  ) => void;
  readonly dragLineElement: (
    e: React.MouseEvent,
    element: PPTLineElement,
    command: OperateLineHandlers,
  ) => void;
  readonly moveShapeKeypoint: (
    e: React.MouseEvent,
    element: PPTShapeElement,
    index: number,
  ) => void;
  readonly openLinkDialog: () => void;
}

export function Operate({
  elementInfo,
  isSelected,
  isActive,
  isActiveGroupElement,
  isMultiSelect,
  rotateElement,
```

### components/slide-renderer/Editor/Canvas/Operate/CommonElementOperate.tsx
```
import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type {
  PPTVideoElement,
  PPTLatexElement,
  PPTAudioElement,
  PPTChartElement,
} from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

type PPTElement = PPTVideoElement | PPTLatexElement | PPTAudioElement | PPTChartElement;

interface CommonElementOperateProps {
  readonly elementInfo: PPTElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function CommonElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: CommonElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const scaleWidth = useMemo(
    () => elementInfo.width * canvasScale,
    [elementInfo.width, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );
  const { resizeHandlers, borderLines } = useCommonOperate(scaleWidth, scaleHeight);

  const cannotRotate = useMemo(
    () => ['chart', 'video', 'audio'].includes(elementInfo.type),
    [elementInfo.type],
  );

  return (
    <div className="common-element-operate">
      {borderLines.map((line) => (
        <BorderLine
          key={line.type}
          type={line.type}
          style={line.style}
          className="operate-border-line"
        />
      ))}
```

### components/slide-renderer/Editor/Canvas/Operate/RotateHandler.tsx
```
interface RotateHandlerProps {
  readonly style?: React.CSSProperties;
  readonly className?: string;
  readonly onMouseDown?: (e: React.MouseEvent) => void;
}

export function RotateHandler({ style, className, onMouseDown }: RotateHandlerProps) {
  return (
    <div
      className={`rotate-handler absolute w-[10px] h-[10px] -top-[25px] -ml-[5px] border border-primary bg-white rounded-[1px] cursor-grab active:cursor-grabbing ${className || ''}`}
      style={style}
      onMouseDown={onMouseDown}
    />
  );
}
```

### components/slide-renderer/Editor/Canvas/Operate/LineElementOperate.tsx
```
import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTLineElement } from '@/lib/types/slides';
import { OperateLineHandlers } from '@/lib/types/edit';
import { ResizeHandler } from './ResizeHandler';

interface LineElementOperateProps {
  readonly elementInfo: PPTLineElement;
  readonly handlerVisible: boolean;
  readonly dragLineElement: (
    e: React.MouseEvent,
    element: PPTLineElement,
    command: OperateLineHandlers,
  ) => void;
}

export function LineElementOperate({
  elementInfo,
  handlerVisible,
  dragLineElement,
}: LineElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const svgWidth = useMemo(
    () => Math.max(elementInfo.start[0], elementInfo.end[0]),
    [elementInfo.start, elementInfo.end],
  );
  const svgHeight = useMemo(
    () => Math.max(elementInfo.start[1], elementInfo.end[1]),
    [elementInfo.start, elementInfo.end],
  );

  const resizeHandlers = useMemo(() => {
    const handlers = [
      {
        handler: OperateLineHandlers.START,
        style: {
          left: elementInfo.start[0] * canvasScale + 'px',
          top: elementInfo.start[1] * canvasScale + 'px',
        },
      },
      {
        handler: OperateLineHandlers.END,
        style: {
          left: elementInfo.end[0] * canvasScale + 'px',
          top: elementInfo.end[1] * canvasScale + 'px',
        },
      },
    ];

    if (elementInfo.curve || elementInfo.broken || elementInfo.broken2) {
      const ctrlHandler = (elementInfo.curve || elementInfo.broken || elementInfo.broken2) as [
        number,
        number,
      ];

      handlers.push({
        handler: OperateLineHandlers.C,
        style: {
          left: ctrlHandler[0] * canvasScale + 'px',
```

### components/slide-renderer/Editor/Canvas/Operate/MultiSelectOperate.tsx
```
import { useMemo, useEffect, useState } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTElement } from '@/lib/types/slides';
import { getElementListRange } from '@/lib/utils/element';
import type { OperateResizeHandlers, MultiSelectRange } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface MultiSelectOperateProps {
  readonly elementList: PPTElement[];
  readonly scaleMultiElement: (
    e: React.MouseEvent,
    range: MultiSelectRange,
    command: OperateResizeHandlers,
  ) => void;
}

export function MultiSelectOperate({ elementList, scaleMultiElement }: MultiSelectOperateProps) {
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const canvasScale = useCanvasStore.use.canvasScale();

  const localActiveElementList = useMemo(
    () => elementList.filter((el) => activeElementIdList.includes(el.id)),
    [elementList, activeElementIdList],
  );

  const [range, setRange] = useState<MultiSelectRange>({
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
  });

  // Calculate border lines and resize handlers based on the multi-select range on canvas
  const width = useMemo(() => (range.maxX - range.minX) * canvasScale, [range, canvasScale]);
  const height = useMemo(() => (range.maxY - range.minY) * canvasScale, [range, canvasScale]);
  const { resizeHandlers, borderLines } = useCommonOperate(width, height);

  // Calculate the overall range of multi-selected elements on canvas
  useEffect(() => {
    const { minX, maxX, minY, maxY } = getElementListRange(localActiveElementList);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement requires effect
    setRange({ minX, maxX, minY, maxY });
  }, [localActiveElementList]);

  // Disable resize in multi-select: only non-rotated images and shapes can be resized
  const disableResize = useMemo(() => {
    return localActiveElementList.some((item) => {
      if ((item.type === 'image' || item.type === 'shape') && !item.rotate) return false;
      return true;
    });
  }, [localActiveElementList]);

  return (
    <div
      className="multi-select-operate absolute top-0 left-0 z-44"
      style={{
        left: range.minX * canvasScale + 'px',
        top: range.minY * canvasScale + 'px',
```

### components/slide-renderer/Editor/Canvas/Operate/ResizeHandler.tsx
```
import { useMemo } from 'react';
import type { OperateResizeHandlers } from '@/lib/types/edit';

interface ResizeHandlerProps {
  readonly type?: OperateResizeHandlers;
  readonly rotate?: number;
  readonly style?: React.CSSProperties;
  readonly className?: string;
  readonly onMouseDown?: (e: React.MouseEvent) => void;
}

export function ResizeHandler({
  type,
  rotate = 0,
  style,
  className,
  onMouseDown,
}: ResizeHandlerProps) {
  const rotateClassName = useMemo(() => {
    const prefix = 'rotate-';
    if (rotate > -22.5 && rotate <= 22.5) return prefix + '0';
    else if (rotate > 22.5 && rotate <= 67.5) return prefix + '45';
    else if (rotate > 67.5 && rotate <= 112.5) return prefix + '90';
    else if (rotate > 112.5 && rotate <= 157.5) return prefix + '135';
    else if (rotate > 157.5 || rotate <= -157.5) return prefix + '0';
    else if (rotate > -157.5 && rotate <= -112.5) return prefix + '45';
    else if (rotate > -112.5 && rotate <= -67.5) return prefix + '90';
    else if (rotate > -67.5 && rotate <= -22.5) return prefix + '135';
    return prefix + '0';
  }, [rotate]);

  // Map rotation and handler type to cursor style
  const cursorClass = useMemo(() => {
    const key = `${type}.${rotateClassName}`;
    const cursorMap: Record<string, string> = {
      // nwse-resize (northwest-southeast)
      'left-top.rotate-0': 'cursor-nwse-resize',
      'right-bottom.rotate-0': 'cursor-nwse-resize',
      'left.rotate-45': 'cursor-nwse-resize',
      'right.rotate-45': 'cursor-nwse-resize',
      'left-bottom.rotate-90': 'cursor-nwse-resize',
      'right-top.rotate-90': 'cursor-nwse-resize',
      'top.rotate-135': 'cursor-nwse-resize',
      'bottom.rotate-135': 'cursor-nwse-resize',

      // ns-resize (north-south)
      'top.rotate-0': 'cursor-ns-resize',
      'bottom.rotate-0': 'cursor-ns-resize',
      'left-top.rotate-45': 'cursor-ns-resize',
      'right-bottom.rotate-45': 'cursor-ns-resize',
      'left.rotate-90': 'cursor-ns-resize',
      'right.rotate-90': 'cursor-ns-resize',
      'left-bottom.rotate-135': 'cursor-ns-resize',
      'right-top.rotate-135': 'cursor-ns-resize',

      // nesw-resize (northeast-southwest)
      'left-bottom.rotate-0': 'cursor-nesw-resize',
      'right-top.rotate-0': 'cursor-nesw-resize',
      'top.rotate-45': 'cursor-nesw-resize',
      'bottom.rotate-45': 'cursor-nesw-resize',
```

### components/slide-renderer/Editor/Canvas/Operate/ImageElementOperate.tsx
```
import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTImageElement } from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface ImageElementOperateProps {
  readonly elementInfo: PPTImageElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTImageElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTImageElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function ImageElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: ImageElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const clipingImageElementId = useCanvasStore.use.clipingImageElementId();

  const isCliping = useMemo(
    () => clipingImageElementId === elementInfo.id,
    [clipingImageElementId, elementInfo.id],
  );

  const scaleWidth = useMemo(
    () => elementInfo.width * canvasScale,
    [elementInfo.width, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );
  const { resizeHandlers, borderLines } = useCommonOperate(scaleWidth, scaleHeight);

  return (
    <div className={`image-element-operate ${isCliping ? 'invisible' : ''}`}>
      {borderLines.map((line) => (
        <BorderLine
          key={line.type}
          type={line.type}
          style={line.style}
          className="operate-border-line"
        />
      ))}
      {handlerVisible && (
        <>
          {resizeHandlers.map((point) => (
            <ResizeHandler
              key={point.direction}
              type={point.direction}
```

### components/slide-renderer/Editor/Canvas/Operate/TextElementOperate.tsx
```
import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTTextElement } from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface TextElementOperateProps {
  readonly elementInfo: PPTTextElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTTextElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTTextElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function TextElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: TextElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const scaleWidth = useMemo(
    () => elementInfo.width * canvasScale,
    [elementInfo.width, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );

  const { textElementResizeHandlers, verticalTextElementResizeHandlers, borderLines } =
    useCommonOperate(scaleWidth, scaleHeight);
  const resizeHandlers = useMemo(
    () => (elementInfo.vertical ? verticalTextElementResizeHandlers : textElementResizeHandlers),
    [elementInfo.vertical, textElementResizeHandlers, verticalTextElementResizeHandlers],
  );

  return (
    <div className="text-element-operate">
      {borderLines.map((line) => (
        <BorderLine
          key={line.type}
          type={line.type}
          style={line.style}
          className="operate-border-line"
        />
      ))}
      {handlerVisible && (
        <>
          {resizeHandlers.map((point) => (
            <ResizeHandler
              key={point.direction}
              type={point.direction}
```

### components/slide-renderer/Editor/Canvas/Operate/BorderLine.tsx
```
import type { OperateBorderLines } from '@/lib/types/edit';

interface BorderLineProps {
  readonly type: OperateBorderLines;
  readonly isWide?: boolean;
  readonly style?: React.CSSProperties;
  readonly className?: string;
}

export function BorderLine({ type, isWide = false, style, className }: BorderLineProps) {
  const borderClass = {
    top: 'border-t',
    bottom: 'border-b',
    left: 'border-l',
    right: 'border-r',
  }[type];

  const wideBeforeClass = isWide
    ? {
        top: 'before:absolute before:-top-2 before:-left-2 before:w-[calc(100%+16px)] before:h-4 before:bg-transparent before:cursor-move before:content-[""]',
        bottom:
          'before:absolute before:-bottom-2 before:-left-2 before:w-[calc(100%+16px)] before:h-4 before:bg-transparent before:cursor-move before:content-[""]',
        left: 'before:absolute before:-top-2 before:-left-2 before:w-4 before:h-[calc(100%+16px)] before:bg-transparent before:cursor-move before:content-[""]',
        right:
          'before:absolute before:-top-2 before:-right-2 before:w-4 before:h-[calc(100%+16px)] before:bg-transparent before:cursor-move before:content-[""]',
      }[type]
    : '';

  return (
    <div
      className={`border-line absolute inset-0 border-dashed border-primary ${borderClass} ${wideBeforeClass} ${className || ''}`}
      style={style}
    />
  );
}
```

### components/slide-renderer/Editor/Canvas/hooks/useDrop.ts
```
import { useEffect, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';

export function useDrop(elementRef: RefObject<HTMLElement | null>) {
  const disableHotkeys = useCanvasStore.use.disableHotkeys();

  useEffect(() => {
    const element = elementRef.current;
    // Handle drop of elements/pages onto canvas
    const handleDrop = (e: DragEvent) => {
      if (!e.dataTransfer || e.dataTransfer.items.length === 0) return;
      if (disableHotkeys) return;

      const firstItem = e.dataTransfer.items[0];
      if (firstItem && firstItem.kind === 'string' && firstItem.type === 'text/plain') {
        firstItem.getAsString((_text) => {
          if (disableHotkeys) return;
          // TODO: implement createTextElement
        });
      }
    };

    const preventDefault = (e: DragEvent) => e.preventDefault();

    if (element) {
      element.addEventListener('drop', handleDrop);
    }

    document.addEventListener('dragleave', preventDefault);
    document.addEventListener('drop', preventDefault);
    document.addEventListener('dragenter', preventDefault);
    document.addEventListener('dragover', preventDefault);

    return () => {
      if (element) {
        element.removeEventListener('drop', handleDrop);
      }

      document.removeEventListener('dragleave', preventDefault);
      document.removeEventListener('drop', preventDefault);
      document.removeEventListener('dragenter', preventDefault);
      document.removeEventListener('dragover', preventDefault);
    };
  }, [elementRef, disableHotkeys]);
}
```

### components/slide-renderer/Editor/Canvas/hooks/useDragLineElement.ts
```
import { useCallback } from 'react';
import { useKeyboardStore } from '@/lib/store/keyboard';
import { useCanvasStore } from '@/lib/store';
import type { PPTElement, PPTLineElement } from '@/lib/types/slides';
import { OperateLineHandlers } from '@/lib/types/edit';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

interface AdsorptionPoint {
  x: number;
  y: number;
}

/**
 * Drag line element Hook
 *
 * @param elementListRef - Element list ref (used to read the latest value on mouseup)
 * @param setElementList - Element list setter (used to trigger re-render)
 */
export function useDragLineElement(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
) {
  const updateSlide = useCanvasOperations().updateSlide;
  const canvasScale = useCanvasStore.use.canvasScale();
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());
  const { addHistorySnapshot } = useHistorySnapshot();

  // Drag line endpoint
  const dragLineElement = useCallback(
    (e: React.MouseEvent, element: PPTLineElement, command: OperateLineHandlers) => {
      let isMouseDown = true;

      const sorptionRange = 8;

      const startPageX = e.pageX;
      const startPageY = e.pageY;

      const adsorptionPoints: AdsorptionPoint[] = [];

      // Get the 8 scale points of all non-rotated, non-line elements as adsorption positions
      for (let i = 0; i < elementListRef.current.length; i++) {
        const _element = elementListRef.current[i];
        if (_element.type === 'line' || _element.rotate) continue;

        const left = _element.left;
        const top = _element.top;
        const width = _element.width;
        const height = _element.height;

        const right = left + width;
        const bottom = top + height;
        const centerX = top + height / 2;
        const centerY = left + width / 2;

        const topPoint = { x: centerY, y: top };
        const bottomPoint = { x: centerY, y: bottom };
        const leftPoint = { x: left, y: centerX };
        const rightPoint = { x: right, y: centerX };

```

### components/slide-renderer/Editor/Canvas/hooks/useCommonOperate.ts
```
import { useMemo } from 'react';
import { OperateResizeHandlers, OperateBorderLines } from '@/lib/types/edit';

export function useCommonOperate(width: number, height: number) {
  // Element resize handlers
  const resizeHandlers = useMemo(() => {
    return [
      { direction: OperateResizeHandlers.LEFT_TOP, style: {} },
      {
        direction: OperateResizeHandlers.TOP,
        style: { left: width / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT_TOP,
        style: { left: width + 'px' },
      },
      {
        direction: OperateResizeHandlers.LEFT,
        style: { top: height / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT,
        style: { left: width + 'px', top: height / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.LEFT_BOTTOM,
        style: { top: height + 'px' },
      },
      {
        direction: OperateResizeHandlers.BOTTOM,
        style: { left: width / 2 + 'px', top: height + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT_BOTTOM,
        style: { left: width + 'px', top: height + 'px' },
      },
    ];
  }, [width, height]);

  // Text element resize handlers
  const textElementResizeHandlers = useMemo(() => {
    return [
      {
        direction: OperateResizeHandlers.LEFT,
        style: { top: height / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT,
        style: { left: width + 'px', top: height / 2 + 'px' },
      },
    ];
  }, [width, height]);

  const verticalTextElementResizeHandlers = useMemo(() => {
    return [
      {
        direction: OperateResizeHandlers.TOP,
        style: { left: width / 2 + 'px' },
      },
      {
```

### components/slide-renderer/Editor/Canvas/hooks/useViewportSize.ts
```
import { useState, useEffect, useRef, useMemo, useCallback, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';

export interface ViewportStyles {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Hook for managing Canvas viewport size and position
 * Handles viewport scaling, positioning, and Canvas dragging
 */
export function useViewportSize(canvasRef: RefObject<HTMLElement | null>) {
  const [viewportLeft, setViewportLeft] = useState(0);
  const [viewportTop, setViewportTop] = useState(0);

  const canvasPercentage = useCanvasStore.use.canvasPercentage();
  const canvasDragged = useCanvasStore.use.canvasDragged();
  const setCanvasScale = useCanvasStore.use.setCanvasScale();
  const setCanvasDragged = useCanvasStore.use.setCanvasDragged();

  const viewportRatio = useCanvasStore.use.viewportRatio();
  const viewportSize = useCanvasStore.use.viewportSize();

  // Initialize viewport position
  const initViewportPosition = useCallback(() => {
    if (!canvasRef.current) return;
    const canvasWidth = canvasRef.current.clientWidth;
    const canvasHeight = canvasRef.current.clientHeight;

    if (canvasHeight / canvasWidth > viewportRatio) {
      const viewportActualWidth = canvasWidth * (canvasPercentage / 100);
      setCanvasScale(viewportActualWidth / viewportSize);
      setViewportLeft((canvasWidth - viewportActualWidth) / 2);
      setViewportTop((canvasHeight - viewportActualWidth * viewportRatio) / 2);
    } else {
      const viewportActualHeight = canvasHeight * (canvasPercentage / 100);
      setCanvasScale(viewportActualHeight / (viewportSize * viewportRatio));
      setViewportLeft((canvasWidth - viewportActualHeight / viewportRatio) / 2);
      setViewportTop((canvasHeight - viewportActualHeight) / 2);
    }
  }, [canvasRef, canvasPercentage, viewportRatio, viewportSize, setCanvasScale]);

  // Update viewport position
  const setViewportPosition = useCallback(
    (newValue: number, oldValue: number) => {
      if (!canvasRef.current) return;
      const canvasWidth = canvasRef.current.clientWidth;
      const canvasHeight = canvasRef.current.clientHeight;

      if (canvasHeight / canvasWidth > viewportRatio) {
        const newViewportActualWidth = canvasWidth * (newValue / 100);
        const oldViewportActualWidth = canvasWidth * (oldValue / 100);
        const newViewportActualHeight = newViewportActualWidth * viewportRatio;
        const oldViewportActualHeight = oldViewportActualWidth * viewportRatio;

        setCanvasScale(newViewportActualWidth / viewportSize);

```

### components/slide-renderer/Editor/Canvas/hooks/useMoveShapeKeypoint.ts
```
import { useCallback } from 'react';
import type { PPTElement, PPTShapeElement } from '@/lib/types/slides';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

interface ShapePathData {
  baseSize: number;
  originPos: number;
  min: number;
  max: number;
  relative: string;
}

/**
 * Move shape keypoint Hook
 *
 * @param elementListRef - Element list ref (used to read the latest value on mouseup)
 * @param setElementList - Element list setter (used to trigger re-render)
 * @param canvasScale - Canvas scale ratio
 */
export function useMoveShapeKeypoint(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
  canvasScale: number,
) {
  const updateSlide = useCanvasOperations().updateSlide;

  const { addHistorySnapshot } = useHistorySnapshot();

  const moveShapeKeypoint = useCallback(
    (e: React.MouseEvent | React.TouchEvent, element: PPTShapeElement, index = 0) => {
      const native = e.nativeEvent;
      const isTouchEvent = native instanceof TouchEvent;
      if (isTouchEvent && !native.changedTouches?.length) return;

      let isMouseDown = true;

      const startPageX = isTouchEvent ? native.changedTouches[0].pageX : native.pageX;
      const startPageY = isTouchEvent ? native.changedTouches[0].pageY : native.pageY;

      const originKeypoints = element.keypoints!;

      const pathFormula = SHAPE_PATH_FORMULAS[element.pathFormula!];
      let shapePathData: ShapePathData | null = null;
      if ('editable' in pathFormula && pathFormula.editable) {
        const getBaseSize = pathFormula.getBaseSize![index];
        const range = pathFormula.range![index];
        const relative = pathFormula.relative![index];
        const keypoint = originKeypoints[index];

        const baseSize = getBaseSize(element.width, element.height);
        const originPos = baseSize * keypoint;
        const [min, max] = range;

        shapePathData = { baseSize, originPos, min, max, relative };
      }

      const handleMouseMove = (e: MouseEvent | TouchEvent) => {
        if (!isMouseDown) return;
```

### components/slide-renderer/Editor/Canvas/hooks/useDragElement.ts
```
import { useCallback } from 'react';
import { useCanvasStore, useKeyboardStore } from '@/lib/store';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import type { PPTElement } from '@/lib/types/slides';
import type { AlignmentLineProps } from '@/lib/types/edit';
import { getRectRotatedRange, uniqAlignLines, type AlignLine } from '@/lib/utils/element';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

/**
 * Drag element hook
 *
 * @param elementListRef - Element list ref (holds latest value)
 * @param setElementList - Element list setter (triggers re-render)
 * @param setAlignmentLines - Alignment lines setter
 */
export function useDragElement(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
  setAlignmentLines: React.Dispatch<React.SetStateAction<AlignmentLineProps[]>>,
) {
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const canvasScale = useCanvasStore.use.canvasScale();
  const shiftKeyState = useKeyboardStore((state) => state.shiftKeyState);

  const viewportRatio = useCanvasStore.use.viewportRatio();
  const viewportSize = useCanvasStore.use.viewportSize();
  const updateSlide = useCanvasOperations().updateSlide;

  const { addHistorySnapshot } = useHistorySnapshot();

  const dragElement = useCallback(
    (e: React.MouseEvent | React.TouchEvent, element: PPTElement) => {
      const native = e.nativeEvent;
      const isTouchEvent = native instanceof TouchEvent;
      if (isTouchEvent && !native.changedTouches?.length) return;

      if (!activeElementIdList.includes(element.id)) return;

      let isMouseDown = true;
      const edgeWidth = viewportSize;
      const edgeHeight = viewportSize * viewportRatio;

      const sorptionRange = 5;

      // Save original element list for computing multi-select offsets
      const originElementList: PPTElement[] = JSON.parse(JSON.stringify(elementListRef.current));
      const originActiveElementList = originElementList.filter((el) =>
        activeElementIdList.includes(el.id),
      );

      const elOriginLeft = element.left;
      const elOriginTop = element.top;
      const elOriginWidth = element.width;
      const elOriginHeight = 'height' in element && element.height ? element.height : 0;
      const elOriginRotate = 'rotate' in element && element.rotate ? element.rotate : 0;

      const startPageX = isTouchEvent ? native.changedTouches[0].pageX : native.pageX;
      const startPageY = isTouchEvent ? native.changedTouches[0].pageY : native.pageY;

```

### components/slide-renderer/Editor/Canvas/hooks/useSelectElement.ts
```
import { useCallback } from 'react';
import { uniq } from 'lodash';
import { useCanvasStore } from '@/lib/store';
import { useKeyboardStore } from '@/lib/store/keyboard';
import type { PPTElement } from '@/lib/types/slides';

/**
 * Hook for handling element selection in Canvas
 * Supports single selection, multi-selection (Ctrl/Shift), and group selection
 */
export function useSelectElement(
  elementListRef: React.RefObject<PPTElement[]>,
  moveElement: (e: React.MouseEvent | React.TouchEvent, element: PPTElement) => void,
) {
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const handleElementId = useCanvasStore.use.handleElementId();
  const editorAreaFocus = useCanvasStore.use.editorAreaFocus();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const setHandleElementId = useCanvasStore.use.setHandleElementId();
  const setActiveGroupElementId = useCanvasStore.use.setActiveGroupElementId();
  const setEditorAreaFocus = useCanvasStore.use.setEditorAreaFocus();

  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  // Select element
  // startMove indicates whether to enter move state after selection
  const selectElement = useCallback(
    (e: React.MouseEvent | React.TouchEvent, element: PPTElement, startMove = true) => {
      if (!editorAreaFocus) setEditorAreaFocus(true);

      // If the target element is not currently selected, set it as selected
      // If Ctrl or Shift is held, enter multi-select mode: add target to current selection; otherwise select only the target
      // If the target is a group member, also select the other members of that group
      if (!activeElementIdList.includes(element.id)) {
        let newActiveIdList: string[] = [];

        if (ctrlOrShiftKeyActive) {
          newActiveIdList = [...activeElementIdList, element.id];
        } else {
          newActiveIdList = [element.id];
        }

        if (element.groupId) {
          const groupMembersId: string[] = [];
          elementListRef.current.forEach((el: PPTElement) => {
            if (el.groupId === element.groupId) groupMembersId.push(el.id);
          });
          newActiveIdList = [...newActiveIdList, ...groupMembersId];
        }

        setActiveElementIdList(uniq(newActiveIdList));
        setHandleElementId(element.id);
      }

      // If the target element is already selected with Ctrl/Shift held, deselect it
      // Unless it's the last selected element, or the group it belongs to is the last selected group
      // If the target is a group member, also deselect other members of that group
      else if (ctrlOrShiftKeyActive) {
        let newActiveIdList: string[] = [];
```

### components/slide-renderer/Editor/Canvas/hooks/useScaleElement.ts
```
import { useCallback } from 'react';
import { useCanvasStore } from '@/lib/store';
import { useKeyboardStore } from '@/lib/store/keyboard';
import type {
  PPTElement,
  PPTLineElement,
  PPTImageElement,
  PPTShapeElement,
} from '@/lib/types/slides';
import {
  OperateResizeHandlers,
  type AlignmentLineProps,
  type MultiSelectRange,
} from '@/lib/types/edit';
import { MIN_SIZE } from '@/configs/element';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { type AlignLine, uniqAlignLines } from '@/lib/utils/element';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

interface RotateElementData {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Calculate the positions of the eight scale points of a rotated element
 * @param element Original position and size of the element
 * @param angle Rotation angle
 */
const getRotateElementPoints = (element: RotateElementData, angle: number) => {
  const { left, top, width, height } = element;

  const radius = Math.sqrt(Math.pow(width, 2) + Math.pow(height, 2)) / 2;
  const auxiliaryAngle = (Math.atan(height / width) * 180) / Math.PI;

  const tlbraRadian = ((180 - angle - auxiliaryAngle) * Math.PI) / 180;
  const trblaRadian = ((auxiliaryAngle - angle) * Math.PI) / 180;
  const taRadian = ((90 - angle) * Math.PI) / 180;
  const raRadian = (angle * Math.PI) / 180;

  const halfWidth = width / 2;
  const halfHeight = height / 2;

  const middleLeft = left + halfWidth;
  const middleTop = top + halfHeight;

  const leftTopPoint = {
    left: middleLeft + radius * Math.cos(tlbraRadian),
    top: middleTop - radius * Math.sin(tlbraRadian),
  };
  const topPoint = {
    left: middleLeft + halfHeight * Math.cos(taRadian),
    top: middleTop - halfHeight * Math.sin(taRadian),
  };
  const rightTopPoint = {
    left: middleLeft + radius * Math.cos(trblaRadian),
    top: middleTop - radius * Math.sin(trblaRadian),
```

### components/slide-renderer/Editor/Canvas/hooks/useInsertFromCreateSelection.ts
```
import { useCallback, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { CreateElementSelectionData } from '@/lib/types/edit';

export function useInsertFromCreateSelection(viewportRef: RefObject<HTMLElement | null>) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const creatingElement = useCanvasStore.use.creatingElement();
  const setCreatingElement = useCanvasStore.use.setCreatingElement();

  // Calculate selection position and size from the start and end points of mouse drag selection
  const formatCreateSelection = useCallback(
    (selectionData: CreateElementSelectionData) => {
      const { start, end } = selectionData;

      if (!viewportRef.current) return;
      const viewportRect = viewportRef.current.getBoundingClientRect();

      const [startX, startY] = start;
      const [endX, endY] = end;
      const minX = Math.min(startX, endX);
      const maxX = Math.max(startX, endX);
      const minY = Math.min(startY, endY);
      const maxY = Math.max(startY, endY);

      const left = (minX - viewportRect.x) / canvasScale;
      const top = (minY - viewportRect.y) / canvasScale;
      const width = (maxX - minX) / canvasScale;
      const height = (maxY - minY) / canvasScale;

      return { left, top, width, height };
    },
    [viewportRef, canvasScale],
  );

  // Calculate line position and start/end points on canvas from the start and end points of mouse drag selection
  const formatCreateSelectionForLine = useCallback(
    (selectionData: CreateElementSelectionData) => {
      const { start, end } = selectionData;

      if (!viewportRef.current) return;
      const viewportRect = viewportRef.current.getBoundingClientRect();

      const [startX, startY] = start;
      const [endX, endY] = end;
      const minX = Math.min(startX, endX);
      const maxX = Math.max(startX, endX);
      const minY = Math.min(startY, endY);
      const maxY = Math.max(startY, endY);

      const left = (minX - viewportRect.x) / canvasScale;
      const top = (minY - viewportRect.y) / canvasScale;
      const width = (maxX - minX) / canvasScale;
      const height = (maxY - minY) / canvasScale;

      const _start: [number, number] = [startX === minX ? 0 : width, startY === minY ? 0 : height];
      const _end: [number, number] = [endX === minX ? 0 : width, endY === minY ? 0 : height];

      return {
        left,
        top,
```

### components/slide-renderer/Editor/Canvas/hooks/useMouseSelection.ts
```
import { useState, useCallback, type RefObject } from 'react';
import { useKeyboardStore } from '@/lib/store/keyboard';
import { useCanvasStore } from '@/lib/store';
import type { PPTElement } from '@/lib/types/slides';
import { getElementRange } from '@/lib/utils/element';

export function useMouseSelection(
  elementListRef: React.RefObject<PPTElement[]>,
  viewportRef: RefObject<HTMLElement | null>,
) {
  const [mouseSelectionVisible, setMouseSelectionVisible] = useState(false);
  const [mouseSelectionQuadrant, setMouseSelectionQuadrant] = useState(1);
  const [mouseSelection, setMouseSelection] = useState({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  });

  const canvasScale = useCanvasStore.use.canvasScale();
  const hiddenElementIdList = useCanvasStore.use.hiddenElementIdList();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  // Update mouse selection range
  const updateMouseSelection = useCallback(
    (e: React.MouseEvent) => {
      if (!viewportRef.current) return;

      let isMouseDown = true;
      const viewportRect = viewportRef.current.getBoundingClientRect();

      const minSelectionRange = 5;

      const startPageX = e.pageX;
      const startPageY = e.pageY;

      const left = (startPageX - viewportRect.x) / canvasScale;
      const top = (startPageY - viewportRect.y) / canvasScale;

      // Initialize selection start position and defaults
      setMouseSelection({
        top: top,
        left: left,
        width: 0,
        height: 0,
      });
      setMouseSelectionVisible(false);
      setMouseSelectionQuadrant(4);

      const handleMouseMove = (e: MouseEvent) => {
        if (!isMouseDown) return;

        const currentPageX = e.pageX;
        const currentPageY = e.pageY;

        const offsetWidth = (currentPageX - startPageX) / canvasScale;
        const offsetHeight = (currentPageY - startPageY) / canvasScale;

        const width = Math.abs(offsetWidth);
```

### components/slide-renderer/Editor/Canvas/hooks/useRotateElement.ts
```
import { useCallback, type RefObject } from 'react';
import type {
  PPTElement,
  PPTLineElement,
  PPTVideoElement,
  PPTAudioElement,
  PPTChartElement,
} from '@/lib/types/slides';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

/**
 * Calculate the angle (in radians) of the line from the origin to the given coordinates
 * @param x Coordinate x
 * @param y Coordinate y
 */
const getAngleFromCoordinate = (x: number, y: number) => {
  const radian = Math.atan2(x, y);
  const angle = (180 / Math.PI) * radian;
  return angle;
};

/**
 * Rotate element Hook
 *
 * @param elementListRef - Element list ref (stores the latest value)
 * @param setElementList - Element list setter (used to trigger re-render)
 * @param viewportRef - Viewport reference
 * @param canvasScale - Canvas scale ratio
 */
export function useRotateElement(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
  viewportRef: RefObject<HTMLElement | null>,
  canvasScale: number,
) {
  const updateSlide = useCanvasOperations().updateSlide;

  const { addHistorySnapshot } = useHistorySnapshot();

  // Rotate element
  const rotateElement = useCallback(
    (
      e: React.MouseEvent | React.TouchEvent,
      element: Exclude<
        PPTElement,
        PPTChartElement | PPTLineElement | PPTVideoElement | PPTAudioElement
      >,
    ) => {
      const native = e.nativeEvent;
      const isTouchEvent = native instanceof TouchEvent;
      if (isTouchEvent && !native.changedTouches?.length) return;

      let isMouseDown = true;
      let angle = 0;
      const elOriginRotate = element.rotate || 0;

      const elLeft = element.left;
      const elTop = element.top;
      const elWidth = element.width;
```

### components/scene-renderers/pbl/chat-panel.tsx
```
'use client';

import { useState, useRef, useEffect } from 'react';
import { ArrowUp } from 'lucide-react';
import type { PBLChatMessage, PBLIssue } from '@/lib/pbl/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { MessageResponse } from '@/components/ai-elements/message';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';

interface ChatPanelProps {
  readonly messages: PBLChatMessage[];
  readonly currentIssue: PBLIssue | null;
  readonly userRole: string;
  readonly isLoading: boolean;
  readonly onSendMessage: (text: string) => void;
}

export function ChatPanel({
  messages,
  currentIssue,
  userRole,
  isLoading,
  onSendMessage,
}: ChatPanelProps) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // Draft cache
  const {
    cachedValue: cachedDraft,
    updateCache: updateDraftCache,
    clearCache: clearDraftCache,
  } = useDraftCache<string>({ key: 'pblChatDraft' });

  // Restore draft: use lazy initializer for first render, then sync via derived state
  const [prevCachedDraft, setPrevCachedDraft] = useState(cachedDraft);
  if (cachedDraft !== prevCachedDraft) {
    setPrevCachedDraft(cachedDraft);
    if (cachedDraft) {
      setInput(cachedDraft);
    }
  }

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleInputChange = (value: string) => {
    setInput(value);
    updateDraftCache(value);
  };

  const handleSubmit = () => {
    if (!input.trim() || isLoading) return;
    onSendMessage(input.trim());
```

### components/scene-renderers/pbl/guide.tsx
```
'use client';

import { HelpCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';

/**
 * Inline guide shown below the role selection cards.
 * Hover to reveal the 3-step PBL workflow as a popover above.
 */
export function PBLGuideInline() {
  const { t } = useI18n();

  return (
    <HoverCard openDelay={0} closeDelay={150}>
      <div className="w-full flex justify-center">
        <HoverCardTrigger asChild>
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <HelpCircle className="w-4 h-4" />
            <span>{t('pbl.guide.howItWorks')}</span>
          </button>
        </HoverCardTrigger>
      </div>
      <HoverCardContent
        side="top"
        collisionPadding={16}
        className="w-[380px] overflow-y-auto rounded-xl p-5"
        style={{
          maxHeight: 'var(--radix-hover-card-content-available-height, 70vh)',
        }}
      >
        <GuideContent />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Help button in workspace toolbar — hover to show guide popover.
 */
export function PBLGuidePanel() {
  const { t } = useI18n();

  return (
    <HoverCard openDelay={0} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button
          className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={t('pbl.guide.help')}
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="end"
        collisionPadding={16}
        className="w-[380px] overflow-y-auto rounded-xl p-5"
        style={{
          maxHeight: 'var(--radix-hover-card-content-available-height, 80vh)',
```

### components/scene-renderers/pbl/use-pbl-chat.ts
```
'use client';

/**
 * PBL Chat Hook - Manages chat state, @mention parsing, and API calls
 */

import { useState, useCallback } from 'react';
import type { PBLProjectConfig, PBLChatMessage, PBLAgent, PBLIssue } from '@/lib/pbl/types';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';

const log = createLogger('PBLChat');

interface UsePBLChatOptions {
  projectConfig: PBLProjectConfig;
  userRole: string;
  onConfigUpdate: (config: PBLProjectConfig) => void;
}

export function usePBLChat({ projectConfig, userRole, onConfigUpdate }: UsePBLChatOptions) {
  const { t } = useI18n();
  const [isLoading, setIsLoading] = useState(false);

  const messages = projectConfig.chat.messages;

  const currentIssue = projectConfig.issueboard.issues.find((i) => i.is_active) || null;

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return;

      const updatedConfig = {
        ...projectConfig,
        chat: {
          ...projectConfig.chat,
          messages: [...projectConfig.chat.messages],
        },
      };

      // Add user message
      const userMsg: PBLChatMessage = {
        id: `msg_${Date.now()}_user`,
        agent_name: userRole,
        message: text,
        timestamp: Date.now(),
        read_by: [userRole],
      };
      updatedConfig.chat.messages.push(userMsg);
      onConfigUpdate(updatedConfig);

      // Parse @mention to determine target agent, fallback to question agent
      const targetAgent = resolveTargetAgent(text, currentIssue, projectConfig.agents);
      if (!targetAgent) return;

      setIsLoading(true);

      try {
        const modelConfig = getCurrentModelConfig();
        const headers: Record<string, string> = {
```

### components/scene-renderers/pbl/workspace.tsx
```
'use client';

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import { IssueboardPanel } from './issueboard-panel';
import { ChatPanel } from './chat-panel';
import { usePBLChat } from './use-pbl-chat';
import { PBLGuidePanel } from './guide';
import { useI18n } from '@/lib/hooks/use-i18n';

interface PBLWorkspaceProps {
  readonly projectConfig: PBLProjectConfig;
  readonly userRole: string;
  readonly onConfigUpdate: (config: PBLProjectConfig) => void;
  readonly onReset: () => void;
}

export function PBLWorkspace({
  projectConfig,
  userRole,
  onConfigUpdate,
  onReset,
}: PBLWorkspaceProps) {
  const { t } = useI18n();
  const [showConfirm, setShowConfirm] = useState(false);

  const { messages, isLoading, sendMessage, currentIssue } = usePBLChat({
    projectConfig,
    userRole,
    onConfigUpdate,
  });

  return (
    <div className="flex h-full w-full">
      {/* Left: Issueboard (~35%) */}
      <div className="w-[35%] min-w-[280px] border-r overflow-hidden flex flex-col">
        {/* Back button bar */}
        <div className="px-3 pt-2 flex items-center gap-1.5">
          {!showConfirm ? (
            <div className="flex items-center gap-1 flex-1">
              <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-muted"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{t('pbl.workspace.restart')}</span>
              </button>
              <div className="ml-auto">
                <PBLGuidePanel />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">{t('pbl.workspace.confirmRestart')}</span>
              <button
                onClick={() => {
                  setShowConfirm(false);
                  onReset();
                }}
```

### components/scene-renderers/pbl/issueboard-panel.tsx
```
'use client';

import type { PBLIssueboard, PBLIssue } from '@/lib/pbl/types';
import { useI18n } from '@/lib/hooks/use-i18n';

interface IssueboardPanelProps {
  readonly issueboard: PBLIssueboard;
}

export function IssueboardPanel({ issueboard }: IssueboardPanelProps) {
  const { t } = useI18n();
  const sortedIssues = [...issueboard.issues].sort((a, b) => a.index - b.index);

  const doneCount = sortedIssues.filter((i) => i.is_done).length;
  const totalCount = sortedIssues.length;
  const progressPercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b">
        <h2 className="font-semibold text-sm">{t('pbl.issueboard.title')}</h2>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {doneCount}/{totalCount}
          </span>
        </div>
      </div>

      {/* Issue List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {sortedIssues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} />
        ))}
        {sortedIssues.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t('pbl.issueboard.noIssues')}
          </p>
        )}
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: PBLIssue }) {
  const { t } = useI18n();
  const statusColor = issue.is_done
    ? 'border-green-500/50 bg-green-50 dark:bg-green-950/20'
    : issue.is_active
      ? 'border-primary bg-primary/5'
      : 'border-muted';

  const statusLabel = issue.is_done
    ? t('pbl.issueboard.statusDone')
```

### components/scene-renderers/pbl/role-selection.tsx
```
'use client';

import type { PBLAgent, PBLProjectInfo } from '@/lib/pbl/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { PBLGuideInline } from './guide';

interface PBLRoleSelectionProps {
  readonly projectInfo: PBLProjectInfo;
  readonly agents: PBLAgent[];
  readonly onSelectRole: (agentName: string) => void;
}

export function PBLRoleSelection({ projectInfo, agents, onSelectRole }: PBLRoleSelectionProps) {
  const { t } = useI18n();

  // Only show non-system development roles
  const selectableAgents = agents.filter(
    (a) => !a.is_system_agent && a.role_division === 'development',
  );

  return (
    <div className="flex flex-col items-center h-full overflow-y-auto p-8 bg-gradient-to-b from-background to-muted/30">
      <div className="max-w-2xl w-full space-y-8 my-auto">
        {/* Project Info */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-bold tracking-tight">{projectInfo.title}</h1>
          <p className="text-muted-foreground text-lg">{projectInfo.description}</p>
        </div>

        {/* Role Selection */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-center">{t('pbl.roleSelection.title')}</h2>
          <p className="text-sm text-muted-foreground text-center">
            {t('pbl.roleSelection.description')}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {selectableAgents.map((agent) => (
              <button
                key={agent.name}
                onClick={() => onSelectRole(agent.name)}
                className="group relative flex flex-col items-start gap-2 rounded-xl border-2 border-muted bg-card p-5 text-left transition-all hover:border-primary hover:shadow-md"
              >
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                    {agent.name.charAt(0).toUpperCase()}
                  </div>
                  <h3 className="font-semibold text-base">{agent.name}</h3>
                </div>
                {agent.actor_role && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{agent.actor_role}</p>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* How it works guide */}
        <PBLGuideInline />
      </div>
```

### lib/playback/derived-state.ts
```
/**
 * Derived Playback State - Pure function that computes a high-level PlaybackView
 * from the ~15 raw state variables scattered across Stage.
 *
 * This centralises all "what is happening now?" derivation logic so that
 * both Stage and Roundtable can consume a single, consistent view object
 * instead of re-deriving the same conditions inline.
 */

import type { EngineMode, TriggerEvent } from './types';

// ---------------------------------------------------------------------------
// Input: raw state collected from Stage's useState variables
// ---------------------------------------------------------------------------

export interface PlaybackRawState {
  engineMode: EngineMode;
  lectureSpeech: string | null;
  liveSpeech: string | null;
  speakingAgentId: string | null;
  thinkingState: { stage: string; agentId?: string } | null;
  isCueUser: boolean;
  isTopicPending: boolean;
  chatIsStreaming: boolean;
  discussionTrigger: TriggerEvent | null;
  playbackCompleted: boolean;
  idleText: string | null;
  /** Whether the speaking agent is a student (not teacher). Provided by caller. */
  speakingStudent: boolean;
  /** Active session type — stays set between agent-loop turns (cleared only by doSessionCleanup). */
  sessionType: string | null;
}

// ---------------------------------------------------------------------------
// Output: a single derived view consumed by Roundtable (and Stage for gating)
// ---------------------------------------------------------------------------

export type PlaybackPhase =
  | 'idle'
  | 'lecturePlaying'
  | 'lecturePaused'
  | 'waitingProactive'
  | 'discussionActive'
  | 'discussionPaused'
  | 'cueUser'
  | 'completed';

export type BubbleButtonState = 'bars' | 'play' | 'restart' | 'none';

export interface PlaybackView {
  /** High-level phase — "what is happening right now?" */
  phase: PlaybackPhase;

  /** Text to display in the speech bubble (without userMessage overlay) */
  sourceText: string;

  /** Who owns the speech bubble */
  bubbleRole: 'teacher' | 'agent' | 'user' | null;

  /** Who is actively speaking (avatar highlight) */
```

### lib/playback/engine.ts
```
/**
 * Playback Engine - Unified state machine for lecture playback and live discussion
 *
 * Consumes Scene.actions[] directly via ActionEngine.
 * No intermediate compile step — actions are executed as-is.
 *
 * State machine:
 *
 *                  start()                  pause()
 *   idle ──────────────────→ playing ──────────────→ paused
 *     ▲                         ▲                       │
 *     │                         │  resume()             │
 *     │                         └───────────────────────┘
 *     │
 *     │  handleEndDiscussion()
 *     │                         confirmDiscussion()
 *     │                         / handleUserInterrupt()
 *     │                              │
 *     │                              ▼         pause()
 *     └──────────────────────── live ──────────────→ paused
 *                                 ▲                    │
 *                                 │ resume / user msg  │
 *                                 └────────────────────┘
 */

import type { Scene } from '@/lib/types/stage';
import type { Action, SpeechAction, DiscussionAction } from '@/lib/types/action';
import type {
  EngineMode,
  TopicState,
  PlaybackEngineCallbacks,
  PlaybackSnapshot,
  TriggerEvent,
  Effect,
} from './types';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import { ActionEngine } from '@/lib/action/engine';
import { useCanvasStore } from '@/lib/store/canvas';
import { createLogger } from '@/lib/logger';

const log = createLogger('PlaybackEngine');

export class PlaybackEngine {
  private scenes: Scene[] = [];
  private sceneIndex: number = 0;
  private actionIndex: number = 0;
  private mode: EngineMode = 'idle';
  private consumedDiscussions: Set<string> = new Set();

  // Discussion state save
  private savedSceneIndex: number | null = null;
  private savedActionIndex: number | null = null;

  // Discussion topic state
  private currentTopicState: TopicState | null = null;

  // Dependencies
  private audioPlayer: AudioPlayer;
  private actionEngine: ActionEngine;
  private callbacks: PlaybackEngineCallbacks;
```

### lib/playback/index.ts
```
export * from './types';
export * from './engine';
export * from './derived-state';
```

### lib/playback/types.ts
```
/**
 * Playback Types - Types for lecture playback and live discussion engine
 */

import type { PlaybackSnapshot } from '@/lib/utils/playback-storage';

export type { PlaybackSnapshot };

/** Visual effects (for onEffectFire callback) */
export type Effect =
  | { kind: 'spotlight'; targetId: string; dimOpacity?: number }
  | { kind: 'laser'; targetId: string; color?: string };

/** Engine mode state machine */
export type EngineMode = 'idle' | 'playing' | 'paused' | 'live';

/** Discussion topic state */
export type TopicState = 'active' | 'pending' | 'closed';

/** Trigger event (for proactive discussion card) */
export interface TriggerEvent {
  id: string;
  question: string;
  prompt?: string;
  agentId?: string;
}

/** Playback engine callbacks */
export interface PlaybackEngineCallbacks {
  onModeChange?: (mode: EngineMode) => void;
  onSceneChange?: (sceneId: string) => void;
  onSpeechStart?: (text: string) => void;
  onSpeechEnd?: () => void;
  onTextDelta?: (content: string) => void;
  onSpeakerChange?: (role: string) => void;
  onEffectFire?: (effect: Effect) => void;

  // Proactive discussion
  onProactiveShow?: (trigger: TriggerEvent) => void;
  onProactiveHide?: () => void;

  // Discussion lifecycle
  onDiscussionConfirmed?: (topic: string, prompt?: string, agentId?: string) => void;
  onDiscussionEnd?: () => void;
  onUserInterrupt?: (text: string) => void;

  // Topic / Transcript
  onTopicStart?: (type: 'lecture' | 'discussion', title: string) => void;
  onTopicAppend?: (role: string, text: string) => void;
  onTopicEnd?: () => void;

  // Progress tracking (for persistence)
  onProgress?: (snapshot: PlaybackSnapshot) => void;

  /** Check if a given agent is in the user's selected list (for skipping discussion actions) */
  isAgentSelected?: (agentId: string) => boolean;

  /** Get current playback speed multiplier (e.g. 1, 1.5, 2) */
  getPlaybackSpeed?: () => number;

```

### lib/constants/generation.ts
```
/**
 * Constants for PDF content generation
 * Shared between client and server code
 */

// PDF content truncation limit (characters)
export const MAX_PDF_CONTENT_CHARS = 50000;

// Maximum number of images to send as vision content parts
export const MAX_VISION_IMAGES = 20;
```

### lib/types/provider.ts
```
/**
 * AI Provider Type Definitions
 */

/**
 * Built-in provider IDs
 */
export type BuiltInProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'minimax'
  | 'glm'
  | 'siliconflow'
  | 'doubao';

/**
 * Provider ID (built-in or custom)
 * For custom providers, use string literals prefixed with "custom-"
 */
export type ProviderId = BuiltInProviderId | `custom-${string}`;

/**
 * Provider API types
 */
export type ProviderType = 'openai' | 'anthropic' | 'google';

/**
 * Describes a model's thinking/reasoning API control capability.
 * Models without thinking support simply omit this field from capabilities.
 */
export interface ThinkingCapability {
  /** Can thinking be fully disabled via API? */
  toggleable: boolean;
  /** Can thinking budget/effort intensity be adjusted? */
  budgetAdjustable: boolean;
  /** Is thinking enabled by default (when no config is passed)? */
  defaultEnabled: boolean;
}

/**
 * Unified thinking configuration for LLM calls.
 * The adapter maps this to provider-specific providerOptions.
 */
export interface ThinkingConfig {
  /**
   * Whether thinking should be enabled.
   * - true: enable (use model default or specified budget)
   * - false: disable (adapter uses best-effort for non-toggleable models)
   * - undefined: use model default behavior
   */
  enabled?: boolean;
  /**
   * Budget hint in tokens. Only used when enabled=true or undefined.
   * Adapter maps to closest supported value per provider.
   */
  budgetTokens?: number;
```

### lib/types/slides.ts
```
export const enum ShapePathFormulasKeys {
  ROUND_RECT = 'roundRect',
  ROUND_RECT_DIAGONAL = 'roundRectDiagonal',
  ROUND_RECT_SINGLE = 'roundRectSingle',
  ROUND_RECT_SAMESIDE = 'roundRectSameSide',
  CUT_RECT_DIAGONAL = 'cutRectDiagonal',
  CUT_RECT_SINGLE = 'cutRectSingle',
  CUT_RECT_SAMESIDE = 'cutRectSameSide',
  CUT_ROUND_RECT = 'cutRoundRect',
  MESSAGE = 'message',
  ROUND_MESSAGE = 'roundMessage',
  L = 'L',
  RING_RECT = 'ringRect',
  PLUS = 'plus',
  TRIANGLE = 'triangle',
  PARALLELOGRAM_LEFT = 'parallelogramLeft',
  PARALLELOGRAM_RIGHT = 'parallelogramRight',
  TRAPEZOID = 'trapezoid',
  BULLET = 'bullet',
  INDICATOR = 'indicator',
  DONUT = 'donut',
  DIAGSTRIPE = 'diagStripe',
}

export const enum ElementTypes {
  TEXT = 'text',
  IMAGE = 'image',
  SHAPE = 'shape',
  LINE = 'line',
  CHART = 'chart',
  TABLE = 'table',
  LATEX = 'latex',
  VIDEO = 'video',
  AUDIO = 'audio',
}

/**
 * 渐变
 *
 * type: 渐变类型（径向、线性）
 *
 * colors: 渐变颜色列表（pos: 百分比位置；color: 颜色）
 *
 * rotate: 渐变角度（线性渐变）
 */
export type GradientType = 'linear' | 'radial';
export type GradientColor = {
  pos: number;
  color: string;
};
export interface Gradient {
  type: GradientType;
  colors: GradientColor[];
  rotate: number;
}

export type LineStyleType = 'solid' | 'dashed' | 'dotted';

/**
 * 元素阴影
```

### lib/types/edit.ts
```
import type { ShapePoolItem } from '@/configs/shapes';
import type { LinePoolItem } from '@/configs/lines';
import type { ImageClipDataRange, PPTElementOutline, PPTElementShadow, Gradient } from './slides';

export enum ElementOrderCommands {
  UP = 'up',
  DOWN = 'down',
  TOP = 'top',
  BOTTOM = 'bottom',
}

export enum ElementAlignCommands {
  TOP = 'top',
  BOTTOM = 'bottom',
  LEFT = 'left',
  RIGHT = 'right',
  VERTICAL = 'vertical',
  HORIZONTAL = 'horizontal',
  CENTER = 'center',
}

export const enum OperateBorderLines {
  T = 'top',
  B = 'bottom',
  L = 'left',
  R = 'right',
}

export const enum OperateResizeHandlers {
  LEFT_TOP = 'left-top',
  TOP = 'top',
  RIGHT_TOP = 'right-top',
  LEFT = 'left',
  RIGHT = 'right',
  LEFT_BOTTOM = 'left-bottom',
  BOTTOM = 'bottom',
  RIGHT_BOTTOM = 'right-bottom',
}

export const enum OperateLineHandlers {
  START = 'start',
  END = 'end',
  C = 'ctrl',
  C1 = 'ctrl1',
  C2 = 'ctrl2',
}

export interface AlignmentLineAxis {
  x: number;
  y: number;
}

export interface AlignmentLineProps {
  type: 'vertical' | 'horizontal';
  axis: AlignmentLineAxis;
  length: number;
}

export interface MultiSelectRange {
  minX: number;
```

### lib/types/generation.ts
```
/**
 * Generation Types - Two-Stage Content Generation System
 *
 * Stage 1: User requirements + documents → Scene Outlines (per-page)
 * Stage 2: Scene Outlines → Full Scenes (slide/quiz/interactive/pbl with actions)
 */

import type { ActionType } from './action';
import type { MediaGenerationRequest } from '@/lib/media/types';

// ==================== PDF Image Types ====================

/**
 * Image extracted from PDF with metadata
 */
export interface PdfImage {
  id: string; // e.g., "img_1", "img_2"
  src: string; // base64 data URL (empty when stored in IndexedDB)
  pageNumber: number; // Page number in PDF
  description?: string; // Optional description for AI context
  storageId?: string; // Reference to IndexedDB (session_xxx_img_1)
  width?: number; // Image width (px or normalized)
  height?: number; // Image height (px or normalized)
}

/**
 * Image mapping for post-processing: image_id → base64 URL
 */
export type ImageMapping = Record<string, string>;

// ==================== Stage 1 Input ====================

export interface AudienceProfile {
  gradeLevel: string; // "K-12", "University", "Professional"
  ageRange?: string; // "6-12", "18-25"
  prerequisites?: string[]; // Required prior knowledge
  learningStyles?: ('visual' | 'auditory' | 'kinesthetic' | 'reading')[];
}

export interface StylePreferences {
  tone: 'formal' | 'casual' | 'engaging' | 'academic';
  visualStyle: 'minimalist' | 'colorful' | 'professional' | 'playful';
  interactivityLevel: 'low' | 'medium' | 'high';
  includeExamples: boolean;
  includePractice: boolean;
  language: string; // 'zh-CN', 'en-US'
}

export interface UploadedDocument {
  id: string;
  name: string; // Original filename
  type: 'pdf' | 'docx' | 'pptx' | 'txt' | 'md' | 'image' | 'other';
  size: number; // Bytes
  uploadedAt: Date;
  contentSummary?: string; // Placeholder for parsing
  extractedTopics?: string[]; // Placeholder for parsing
  pageCount?: number;
  storageRef?: string;
}

```

### lib/types/roundtable.ts
```
export const USER_AVATAR = '/avatars/user.png';

export type ParticipantRole = 'teacher' | 'student' | 'user';

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  avatar: string;
  isOnline: boolean;
  isSpeaking?: boolean;
}

export interface MessageAction {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
}

export interface Message {
  id: string;
  senderId: string;
  senderRole: ParticipantRole;
  content: string;
  timestamp: number;
  actions?: MessageAction[];
}
```

### lib/types/action.ts
```
/**
 * Unified Action System
 *
 * Actions are the sole mechanism for agents to interact with the presentation.
 * Two categories:
 * - Fire-and-forget: visual effects on slides (spotlight, laser)
 * - Synchronous: must wait for completion before next action (speech, whiteboard, discussion)
 *
 * Both online (streaming) and offline (playback) paths consume the same Action types.
 */

// ==================== Base ====================

export interface ActionBase {
  id: string;
  title?: string;
  description?: string;
}

// ==================== Fire-and-forget actions ====================

/** Spotlight — focus on a single element, dim everything else */
export interface SpotlightAction extends ActionBase {
  type: 'spotlight';
  elementId: string;
  dimOpacity?: number; // default 0.5
}

/** Laser — point at an element with a laser effect */
export interface LaserAction extends ActionBase {
  type: 'laser';
  elementId: string;
  color?: string; // default '#ff0000'
}

// ==================== Synchronous actions ====================

/** Speech — teacher narration (wait for TTS to finish) */
export interface SpeechAction extends ActionBase {
  type: 'speech';
  text: string;
  audioId?: string;
  voice?: string;
  speed?: number; // default 1.0
}

/** Open whiteboard (wait for animation) */
export interface WbOpenAction extends ActionBase {
  type: 'wb_open';
}

/** Draw text on whiteboard (wait for render) */
export interface WbDrawTextAction extends ActionBase {
  type: 'wb_draw_text';
  elementId?: string; // Custom element ID for later reference (e.g. wb_delete)
  content: string; // HTML string or plain text
  x: number;
  y: number;
  width?: number; // default 400
  height?: number; // default 100
```

### lib/types/pdf.ts
```
/**
 * PDF parsing result types
 * Extended to support advanced features from providers like MinerU
 */

/**
 * Parsed PDF content with text and images
 */
export interface ParsedPdfContent {
  /** Extracted text content from the PDF */
  text: string;

  /** Array of images as base64 data URLs */
  images: string[];

  /** Extracted tables (MinerU feature) */
  tables?: Array<{
    page: number;
    data: string[][];
    caption?: string;
  }>;

  /** Extracted formulas (MinerU feature) */
  formulas?: Array<{
    page: number;
    latex: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  /** Layout analysis (MinerU feature) */
  layout?: Array<{
    page: number;
    type: 'title' | 'text' | 'image' | 'table' | 'formula';
    content: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  /** Metadata about the PDF */
  metadata?: {
    fileName?: string;
    fileSize?: number;
    pageCount: number;
    parser?: string; // 'unpdf' | 'mineru'
    processingTime?: number;
    taskId?: string; // MinerU task ID
    /** Image ID to base64 URL mapping (used in generation pipeline) */
    imageMapping?: Record<string, string>; // e.g., { "img_1": "data:image/png;base64,..." }
    /** PdfImage array with page numbers (used in generation pipeline) */
    pdfImages?: Array<{
      id: string;
      src: string;
      pageNumber: number;
      description?: string;
      width?: number;
      height?: number;
    }>;
    [key: string]: unknown;
  };
}

```

### lib/types/web-search.ts
```
export interface WebSearchSource {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface WebSearchResult {
  answer: string;
  sources: WebSearchSource[];
  query: string;
  responseTime: number;
}
```

### lib/types/export.ts
```
export type DialogForExportTypes = 'image' | 'pdf' | 'json' | 'pptx' | 'pptist' | '';
```

### lib/types/chat.ts
```
/**
 * Shared Type Definitions for Multi-Agent Orchestration
 *
 * Defines the session-based multi-agent conversation system with
 * support for QA, Discussion, and Lecture session types.
 */

import type { UIMessage } from 'ai';

// Session Types
export type SessionType = 'qa' | 'discussion' | 'lecture';
export type SessionStatus = 'idle' | 'active' | 'interrupted' | 'completed';

/**
 * Metadata attached to chat messages
 */
export interface ChatMessageMetadata {
  senderName?: string;
  senderAvatar?: string;
  originalRole?: 'teacher' | 'agent' | 'user';
  actions?: MessageAction[];
  agentId?: string;
  agentColor?: string;
  createdAt?: number;
  interrupted?: boolean;
}

/**
 * Action buttons that can be attached to messages
 */
export interface MessageAction {
  id: string;
  label: string;
  icon?: string;
  variant?: 'spotlight' | 'highlight' | 'reset' | 'insert' | 'draw';
}

/**
 * Chat session representing a conversation with one or more agents
 */
export interface ChatSession {
  id: string;
  type: SessionType;
  title: string;
  status: SessionStatus;
  messages: UIMessage<ChatMessageMetadata>[];
  config: SessionConfig;
  toolCalls: ToolCallRecord[];
  pendingToolCalls: ToolCallRequest[];
  createdAt: number;
  updatedAt: number;
  sceneId?: string;
  lastActionIndex?: number;
}

/**
 * Session configuration
 */
export interface SessionConfig {
  agentIds: string[];
```

### lib/types/settings.ts
```
import type { ProviderId, ModelInfo, ProviderType } from '@/lib/types/provider';

export type SettingsSection =
  | 'general'
  | 'providers'
  | 'agents'
  | 'tts'
  | 'asr'
  | 'pdf'
  | 'image'
  | 'video'
  | 'web-search';

/**
 * Unified provider configuration stored in JSON format
 * Stores all provider-specific settings and metadata in one object
 * Both built-in and custom providers use the same structure
 */
export interface ProviderSettings {
  // Configuration
  apiKey: string;
  baseUrl: string;
  models: ModelInfo[]; // All models (user can edit/delete any)

  // Metadata (same for built-in and custom providers)
  name: string;
  type: ProviderType;
  defaultBaseUrl?: string;
  icon?: string;
  requiresApiKey: boolean;
  isBuiltIn: boolean; // true for built-in providers, false for custom

  // Server-side configuration (set by fetchServerProviders)
  isServerConfigured?: boolean; // Server has API key for this provider
  serverModels?: string[]; // Server-restricted model list (if set)
  serverBaseUrl?: string; // Server-provided base URL override
}

/**
 * Provider configurations storage format
 * Key: providerId, Value: ProviderSettings
 */
export type ProvidersConfig = Record<ProviderId, ProviderSettings>;

export interface EditingModel {
  providerId: ProviderId;
  modelIndex: number | null; // null for new model
  model: ModelInfo;
}
```

### lib/types/stage.ts
```
// Stage and Scene data types
import type { Slide } from '@/lib/types/slides';
import type { Action } from '@/lib/types/action';
import type { PBLProjectConfig } from '@/lib/pbl/types';

export type SceneType = 'slide' | 'quiz' | 'interactive' | 'pbl';

export type StageMode = 'autonomous' | 'playback';

export type Whiteboard = Omit<Slide, 'theme' | 'turningMode' | 'sectionTag' | 'type'>;

/**
 * Stage - Represents the entire classroom/course
 */
export interface Stage {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  // Stage metadata
  language?: string;
  style?: string;
  // Whiteboard data
  whiteboard?: Whiteboard[];
}

/**
 * Scene - Represents a single page/scene in the course
 */
export interface Scene {
  id: string;
  stageId: string; // ID of the parent stage (for data integrity checks)
  type: SceneType;
  title: string;
  order: number; // Display order

  // Type-specific content
  content: SceneContent;

  // Actions to execute during playback
  actions?: Action[];

  // Whiteboards to explain deeply
  whiteboards?: Slide[];

  // Multi-agent discussion configuration
  multiAgent?: {
    enabled: boolean; // Enable multi-agent for this scene
    agentIds: string[]; // Which agents to include (from registry)
    directorPrompt?: string; // Optional custom director instructions
  };

  // Metadata
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Scene content based on type
```

### lib/buffer/stream-buffer.ts
```
import type { DirectorState } from '@/lib/types/chat';

/**
 * StreamBuffer — unified presentation pacing layer.
 *
 * Sits between data sources (SSE stream / PlaybackEngine) and React state.
 * Events are pushed into an ordered queue; a fixed-rate tick loop reveals
 * text character-by-character and fires typed callbacks so both the Chat
 * area and the Roundtable bubble consume identically-paced content.
 *
 * Key invariants:
 *   - ONE source of pacing (this tick loop) — no double typewriter.
 *   - pause() is O(1) instant — tick returns immediately.
 *   - Actions fire only when the tick cursor reaches them (after preceding text).
 *   - Roundtable sees only the current speech segment (resets on action / agent switch).
 */

// ─── Buffer Item Types ───────────────────────────────────────────────

export interface AgentStartItem {
  kind: 'agent_start';
  messageId: string;
  agentId: string;
  agentName: string;
  avatar?: string;
  color?: string;
}

export interface AgentEndItem {
  kind: 'agent_end';
  messageId: string;
  agentId: string;
}

export interface TextItem {
  kind: 'text';
  messageId: string;
  agentId: string;
  /** Unique ID for this text part — distinguishes multiple text items within one message (e.g. lecture). */
  partId: string;
  /** Growable — SSE deltas append here. */
  text: string;
  /** When true, no more text will be appended. Tick can advance past once fully revealed. */
  sealed: boolean;
}

export interface ActionItem {
  kind: 'action';
  messageId: string;
  actionId: string;
  actionName: string;
  params: Record<string, unknown>;
  agentId: string;
}

export interface ThinkingItem {
  kind: 'thinking';
  stage: string;
  agentId?: string;
}
```

### lib/pbl/generate-pbl.ts
```
/**
 * PBL Generation - Agentic Loop using Vercel AI SDK
 *
 * Core generation engine that designs a complete PBL project through
 * multi-step tool calling with generateText + stopWhen.
 *
 * Replaces PBL-Nano's Anthropic SDK direct calls with Vercel AI SDK
 * for multi-model compatibility.
 */

import { tool, stepCountIs } from 'ai';
import { callLLM } from '@/lib/ai/llm';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { PBLProjectConfig } from './types';
import { ModeMCP } from './mcp/mode-mcp';
import { ProjectMCP } from './mcp/project-mcp';
import { AgentMCP } from './mcp/agent-mcp';
import { IssueboardMCP } from './mcp/issueboard-mcp';
import { buildPBLSystemPrompt } from './pbl-system-prompt';
import type { PBLMode } from './types';

export interface GeneratePBLConfig {
  projectTopic: string;
  projectDescription: string;
  targetSkills: string[];
  issueCount?: number;
  language: string;
}

export interface GeneratePBLCallbacks {
  onProgress?: (message: string) => void;
}

/**
 * Generate a complete PBL project configuration using an agentic loop.
 *
 * Uses Vercel AI SDK's generateText with tools and stopWhen to drive
 * a multi-step conversation where the LLM designs the project by
 * calling MCP tools.
 */
export async function generatePBLContent(
  config: GeneratePBLConfig,
  model: LanguageModel,
  callbacks?: GeneratePBLCallbacks,
): Promise<PBLProjectConfig> {
  const { language } = config;

  // Initialize shared state
  const projectConfig: PBLProjectConfig = {
    projectInfo: { title: '', description: '' },
    agents: [],
    issueboard: { agent_ids: [], issues: [], current_issue_id: null },
    chat: { messages: [] },
  };

  // Create MCP instances operating on shared state
  const modeMCP = new ModeMCP(
    ['project_info', 'agent', 'issueboard', 'idle'] as PBLMode[],
    'project_info' as PBLMode,
```

### lib/pbl/pbl-system-prompt.ts
```
/**
 * PBL Generation System Prompt
 *
 * Migrated from PBL-Nano's anything2pbl_nano.ts systemPrompt.
 * Enhanced with multi-language support and configurable parameters.
 */

export interface PBLSystemPromptConfig {
  projectTopic: string;
  projectDescription: string;
  targetSkills: string[];
  issueCount?: number;
  language: string;
}

export function buildPBLSystemPrompt(config: PBLSystemPromptConfig): string {
  const { projectTopic, projectDescription, targetSkills, issueCount = 3, language } = config;

  if (language === 'zh-CN') {
    return buildPBLSystemPromptZH(config);
  }

  return `You are a Teaching Assistant (TA) on a Project-Based Learning platform. You are fully responsible for designing group projects for students based on the course information provided by the teacher.

## Your Responsibility

Design a complete project by:
1. Creating a clear, engaging project title (keep it concise and memorable)
2. Writing a simple, concise project description (2-4 sentences) that covers:
   - What the project is about
   - Key learning objectives
   - What students will accomplish

Keep the description straightforward and easy to understand. Avoid lengthy explanations.

The teacher has provided you with:
- **Project Topic**: ${projectTopic}
- **Project Description**: ${projectDescription}
- **Target Skills**: ${targetSkills.join(', ')}
- **Suggested Number of Issues**: ${issueCount}

Based on this information, you must autonomously design the project. Do not ask for confirmation or additional input - make the best decisions based on the provided context.

## Mode System

You have access to different modes, each providing different sets of tools:
- **project_info**: Tools for setting up basic project information (title, description)
- **agent**: Tools for defining project roles and agents
- **issueboard**: Tools for configuring collaboration workflow
- **idle**: A special mode indicating project configuration is complete

You start in **project_info** mode. Use the \`set_mode\` tool to switch between modes as needed.

## Workflow

1. Start in **project_info** mode: Set up the project title and description
2. Switch to **agent** mode: Define 2-4 development roles students will take on (do NOT create management roles for students)
3. Switch to **issueboard** mode: Create ${issueCount} sequential issues that guide students through the project
4. When all project configuration is complete, switch to **idle** mode

```

### lib/pbl/types.ts
```
/**
 * PBL (Project-Based Learning) Type Definitions
 *
 * Migrated from PBL-Nano with PBL prefix to avoid conflicts with MAIC-OSS types.
 */

export type PBLMode = 'project_info' | 'agent' | 'issueboard' | 'idle';

export interface PBLProjectInfo {
  title: string;
  description: string;
}

export type PBLRoleDivision = 'management' | 'development';

export interface PBLAgent {
  name: string;
  actor_role: string;
  role_division: PBLRoleDivision;
  system_prompt: string;
  default_mode: string;
  delay_time: number;
  env: Record<string, unknown>;
  is_user_role: boolean;
  is_active: boolean;
  is_system_agent: boolean;
}

export interface PBLIssue {
  id: string;
  title: string;
  description: string;
  person_in_charge: string;
  participants: string[];
  notes: string;
  parent_issue: string | null;
  index: number;
  is_done: boolean;
  is_active: boolean;
  generated_questions: string;
  question_agent_name: string;
  judge_agent_name: string;
}

export interface PBLIssueboard {
  agent_ids: string[];
  issues: PBLIssue[];
  current_issue_id: string | null;
}

export interface PBLChatMessage {
  id: string;
  agent_name: string;
  message: string;
  timestamp: number;
  read_by: string[];
}

export interface PBLChat {
  messages: PBLChatMessage[];
```

### lib/pdf/constants.ts
```
/**
 * PDF Provider Constants
 * Separated from pdf-providers.ts to avoid importing sharp in client components
 */

import type { PDFProviderId, PDFProviderConfig } from './types';

/**
 * PDF Provider Registry
 */
export const PDF_PROVIDERS: Record<PDFProviderId, PDFProviderConfig> = {
  unpdf: {
    id: 'unpdf',
    name: 'unpdf',
    requiresApiKey: false,
    icon: '/logos/unpdf.svg',
    features: ['text', 'images', 'metadata'],
  },

  mineru: {
    id: 'mineru',
    name: 'MinerU',
    requiresApiKey: false,
    icon: '/logos/mineru.png',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis'],
  },
};

/**
 * Get all available PDF providers
 */
export function getAllPDFProviders(): PDFProviderConfig[] {
  return Object.values(PDF_PROVIDERS);
}

/**
 * Get PDF provider by ID
 */
export function getPDFProvider(providerId: PDFProviderId): PDFProviderConfig | undefined {
  return PDF_PROVIDERS[providerId];
}
```

### lib/pdf/types.ts
```
/**
 * PDF Parsing Provider Type Definitions
 */

/**
 * PDF Provider IDs
 */
export type PDFProviderId = 'unpdf' | 'mineru';

/**
 * PDF Provider Configuration
 */
export interface PDFProviderConfig {
  id: PDFProviderId;
  name: string;
  requiresApiKey: boolean;
  baseUrl?: string;
  icon?: string;
  features: string[]; // ['text', 'images', 'tables', 'formulas', 'layout-analysis', etc.]
}

/**
 * PDF Parser Configuration for API calls
 */
export interface PDFParserConfig {
  providerId: PDFProviderId;
  apiKey?: string;
  baseUrl?: string;
}

// Note: ParsedPdfContent is imported from @/lib/types/pdf to avoid duplication
```

### lib/pdf/pdf-providers.ts
```
/**
 * PDF Parsing Provider Implementation
 *
 * Factory pattern for routing PDF parsing requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - unpdf: Built-in Node.js PDF parser with text and image extraction
 * - MinerU: Advanced commercial service with OCR, formula, and table extraction
 *   (https://mineru.ai or self-hosted)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to PDFProviderId in lib/pdf/types.ts
 *    Example: | 'tesseract-ocr'
 *
 * 2. Add provider configuration to lib/pdf/constants.ts
 *    Example:
 *    'tesseract-ocr': {
 *      id: 'tesseract-ocr',
 *      name: 'Tesseract OCR',
 *      requiresApiKey: false,
 *      icon: '/tesseract.svg',
 *      features: ['text', 'images', 'ocr']
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function parseWithXxx(config, pdfBuffer): Promise<ParsedPdfContent>
 *    - Accept PDF as Buffer
 *    - Extract text, images, tables, formulas as needed
 *    - Return unified format:
 *      {
 *        text: string,               // Markdown or plain text
 *        images: string[],           // Base64 data URLs
 *        metadata: {
 *          pageCount: number,
 *          parser: string,
 *          ...                       // Provider-specific metadata
 *        }
 *      }
 *
 *    Example:
 *    async function parseWithTesseractOCR(
 *      config: PDFParserConfig,
 *      pdfBuffer: Buffer
 *    ): Promise<ParsedPdfContent> {
 *      const { createWorker } = await import('tesseract.js');
 *
 *      // Convert PDF pages to images
 *      const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
 *      const numPages = pdf.numPages;
 *
 *      const texts: string[] = [];
 *      const images: string[] = [];
 *
 *      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
 *        // Render page to canvas/image
 *        const page = await pdf.getPage(pageNum);
 *        const viewport = page.getViewport({ scale: 2.0 });
 *        const canvas = createCanvas(viewport.width, viewport.height);
```

### lib/chat/action-translations.ts
```
import { Badge } from '@/components/ui/badge';
import { CheckCircleIcon, CircleIcon, ClockIcon, XCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { createElement } from 'react';

/**
 * Map SSE status strings to i18n keys under `actions.status.*`
 */
const statusKeyMap: Record<string, string> = {
  'input-streaming': 'inputStreaming',
  'input-available': 'inputAvailable',
  'output-available': 'outputAvailable',
  'output-error': 'outputError',
  'output-denied': 'outputDenied',
  running: 'running',
  result: 'result',
  error: 'error',
};

/**
 * Resolve an action name to its i18n display name.
 * Falls back to the raw actionName if no translation exists.
 */
export function getActionDisplayName(t: (key: string) => string, actionName: string): string {
  const translated = t(`actions.names.${actionName}`);
  // t() returns the key itself when translation is missing
  return translated === `actions.names.${actionName}` ? actionName : translated;
}

/**
 * Get a localized status badge for action state.
 */
export function getStatusBadge(t: (key: string) => string, state: string): ReactNode {
  const iconMap: Record<string, ReactNode> = {
    'input-streaming': createElement(CircleIcon, { className: 'size-4' }),
    'input-available': createElement(ClockIcon, {
      className: 'size-4 animate-pulse',
    }),
    'output-available': createElement(CheckCircleIcon, {
      className: 'size-4 text-green-600',
    }),
    'output-error': createElement(XCircleIcon, {
      className: 'size-4 text-red-600',
    }),
    'output-denied': createElement(XCircleIcon, {
      className: 'size-4 text-orange-600',
    }),
    running: createElement(ClockIcon, { className: 'size-4 animate-pulse' }),
    result: createElement(CheckCircleIcon, {
      className: 'size-4 text-green-600',
    }),
    error: createElement(XCircleIcon, { className: 'size-4 text-red-600' }),
  };

  const i18nKey = statusKeyMap[state];
  const label = i18nKey ? t(`actions.status.${i18nKey}`) : state;

  return createElement(
    Badge,
    {
```

### lib/action/engine.ts
```
/**
 * ActionEngine — Unified execution layer for all agent actions.
 *
 * Replaces the 28 Vercel AI SDK tools in ai-tools.ts with a single engine
 * that both online (streaming) and offline (playback) paths share.
 *
 * Two execution modes:
 * - Fire-and-forget: spotlight, laser — dispatch and return immediately
 * - Synchronous: speech, whiteboard, discussion — await completion
 */

import type { StageStore } from '@/lib/api/stage-api';
import { createStageAPI } from '@/lib/api/stage-api';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore, isMediaPlaceholder } from '@/lib/store/media-generation';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type {
  Action,
  SpotlightAction,
  LaserAction,
  SpeechAction,
  PlayVideoAction,
  WbDrawTextAction,
  WbDrawShapeAction,
  WbDrawChartAction,
  WbDrawLatexAction,
  WbDrawTableAction,
  WbDeleteAction,
  WbDrawLineAction,
} from '@/lib/types/action';
import katex from 'katex';
import { createLogger } from '@/lib/logger';

const log = createLogger('ActionEngine');

// ==================== SVG Paths for Shapes ====================

const SHAPE_PATHS: Record<string, string> = {
  rectangle: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
  circle: 'M 500 0 A 500 500 0 1 1 499 0 Z',
  triangle: 'M 500 0 L 1000 1000 L 0 1000 Z',
};

// ==================== Helpers ====================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== ActionEngine ====================

/** Default duration (ms) before fire-and-forget effects auto-clear */
const EFFECT_AUTO_CLEAR_MS = 5000;

export class ActionEngine {
  private stageStore: StageStore;
  private stageAPI: ReturnType<typeof createStageAPI>;
  private audioPlayer: AudioPlayer | null;
  private effectTimer: ReturnType<typeof setTimeout> | null = null;

```

### lib/media/media-orchestrator.ts
```
/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls /api/generate/image and /api/generate/video,
 * fetches result blobs, stores in IndexedDB, and updates the Zustand store.
 */

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { SceneOutline } from '@/lib/types/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaOrchestrator');

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

/**
 * Launch media generation for all mediaGenerations declared in outlines.
 * Runs in parallel with content/action generation — does not block.
 */
export async function generateMediaForOutlines(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const settings = useSettingsStore.getState();
  const store = useMediaGenerationStore.getState();

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      // Skip already completed or permanently failed (restored from DB)
      const existing = store.getTask(mg.elementId);
      if (existing?.status === 'done' || existing?.status === 'failed') continue;
      allRequests.push(mg);
    }
  }

  if (allRequests.length === 0) return;

  // Enqueue all as pending
  useMediaGenerationStore.getState().enqueueTasks(stageId, allRequests);

  // Process requests serially — image/video APIs have limited concurrency
  for (const req of allRequests) {
```

### lib/media/video-providers.ts
```
/**
 * Video Generation Service -- routes to provider adapters
 */

import type {
  VideoProviderId,
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
  VideoProviderConfig,
} from './types';
import { generateWithSeedance, testSeedanceConnectivity } from './adapters/seedance-adapter';
import { generateWithKling, testKlingConnectivity } from './adapters/kling-adapter';
import { generateWithVeo, testVeoConnectivity } from './adapters/veo-adapter';

export const VIDEO_PROVIDERS: Record<VideoProviderId, VideoProviderConfig> = {
  seedance: {
    id: 'seedance',
    name: 'Seedance',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    models: [
      { id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro' },
      { id: 'doubao-seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro' },
      {
        id: 'doubao-seedance-1-0-pro-fast-251015',
        name: 'Seedance 1.0 Pro Fast',
      },
      {
        id: 'doubao-seedance-1-0-lite-t2v-250428',
        name: 'Seedance 1.0 Lite T2V',
      },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16', '3:4', '21:9'],
    supportedDurations: [5, 10],
    supportedResolutions: ['480p', '720p', '1080p'],
    maxDuration: 10,
  },
  kling: {
    id: 'kling',
    name: 'Kling',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api-beijing.klingai.com',
    models: [
      { id: 'kling-v2-6', name: 'Kling V2.6' },
      { id: 'kling-v1-6', name: 'Kling V1.6' },
    ],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    supportedDurations: [5, 10],
    maxDuration: 10,
  },
  veo: {
    id: 'veo',
    name: 'Veo',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      { id: 'veo-3.1-fast-generate-001', name: 'Veo 3.1 Fast' },
      { id: 'veo-3.1-generate-001', name: 'Veo 3.1' },
      { id: 'veo-3.0-fast-generate-001', name: 'Veo 3.0 Fast' },
```

### lib/media/types.ts
```
/**
 * Media (Image & Video) Generation Provider Type Definitions
 *
 * Unified types for image generation and video generation
 * with extensible architecture to support multiple providers.
 *
 * Currently Supported Image Providers:
 * - Seedream (ByteDance SDXL-based image generation)
 * - Qwen Image (Alibaba Cloud Wanx image generation)
 * - Nano Banana (Lightweight image generation via Banana.dev)
 *
 * Currently Supported Video Providers (Phase 2):
 * - Seedance (ByteDance video generation)
 * - Kling (Kuaishou video generation)
 * - Veo (Google DeepMind video generation)
 * - Sora (OpenAI video generation)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * Step 1: Add provider ID to the union type
 *   - For Image: Add to ImageProviderId below
 *   - For Video: Add to VideoProviderId below
 *
 * Step 2: Add provider configuration to constants.ts
 *   - Define provider metadata (name, icon, aspect ratios, styles, etc.)
 *   - Add to IMAGE_PROVIDERS or VIDEO_PROVIDERS registry
 *
 * Step 3: Implement provider logic in image-providers.ts or video-providers.ts
 *   - Add case to generateImage() or generateVideo() switch statement
 *   - Implement API call logic for the new provider
 *   - For async task-based providers, implement MediaTaskAdapter
 *
 * Step 4: Add i18n translations
 *   - Add provider name translations in lib/i18n.ts
 *   - Format: `provider{ProviderName}Image` or `provider{ProviderName}Video`
 *
 * Step 5 (Optional): Add provider-specific options
 *   - Extend ImageGenerationOptions or VideoGenerationOptions as needed
 *   - Document provider-specific parameters in JSDoc
 *
 * Example: Adding DALL-E Image Provider
 * =======================================
 * 1. Add 'dall-e' to ImageProviderId union type
 * 2. In constants.ts:
 *    IMAGE_PROVIDERS['dall-e'] = {
 *      id: 'dall-e',
 *      name: 'DALL-E',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.openai.com/v1',
 *      icon: '/openai.svg',
 *      supportedAspectRatios: ['1:1', '16:9', '9:16'],
 *      supportedStyles: ['natural', 'vivid'],
 *      maxResolution: { width: 1024, height: 1024 }
 *    }
 * 3. In image-providers.ts:
 *    case 'dall-e':
 *      return await generateDallEImage(config, options);
 * 4. In i18n.ts:
 *    providerDallEImage: 'DALL-E' / 'DALL-E 图像生成'
 */
```

### lib/media/image-providers.ts
```
/**
 * Image Generation Service -- routes to provider adapters
 */

import type {
  ImageProviderId,
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
  ImageProviderConfig,
} from './types';
import { generateWithSeedream, testSeedreamConnectivity } from './adapters/seedream-adapter';
import { generateWithQwenImage, testQwenImageConnectivity } from './adapters/qwen-image-adapter';
import { generateWithNanoBanana, testNanoBananaConnectivity } from './adapters/nano-banana-adapter';

export const IMAGE_PROVIDERS: Record<ImageProviderId, ImageProviderConfig> = {
  seedream: {
    id: 'seedream',
    name: 'Seedream',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    models: [
      { id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0 Lite' },
      { id: 'doubao-seedream-4-5-251128', name: 'Seedream 4.5' },
      { id: 'doubao-seedream-4-0-250828', name: 'Seedream 4.0' },
      { id: 'doubao-seedream-3-0-t2i-250415', name: 'Seedream 3.0' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
  'qwen-image': {
    id: 'qwen-image',
    name: 'Qwen Image',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    models: [
      { id: 'qwen-image-max', name: 'Qwen Image Max' },
      { id: 'qwen-image-max-2025-12-30', name: 'Qwen Image Max (2025-12-30)' },
      { id: 'qwen-image-plus', name: 'Qwen Image Plus' },
      {
        id: 'qwen-image-plus-2026-01-09',
        name: 'Qwen Image Plus (2026-01-09)',
      },
      { id: 'qwen-image', name: 'Qwen Image' },
      { id: 'z-image-turbo', name: 'Z-Image Turbo' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
  },
  'nano-banana': {
    id: 'nano-banana',
    name: 'Nano Banana (Gemini)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      {
        id: 'gemini-3.1-flash-image-preview',
        name: 'Gemini 3.1 Flash Image (Nano Banana 2)',
      },
      {
        id: 'gemini-3-pro-image-preview',
        name: 'Gemini 3 Pro Image (Nano Banana Pro)',
```

### lib/store/canvas.ts
```
import { create } from 'zustand';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { TextAttrs } from '@/lib/prosemirror/utils';
import { defaultRichTextAttrs } from '@/lib/prosemirror/utils';
import type { TextFormatPainter, ShapeFormatPainter, CreatingElement } from '@/lib/types/edit';
import type { PercentageGeometry } from '@/lib/types/action';

/**
 * Spotlight options
 */
export interface SpotlightOptions {
  radius?: number; // Spotlight radius (pixels)
  dimness?: number; // Background dimming level (0-1)
  transition?: number; // Transition animation duration (milliseconds)
}

/**
 * Highlight overlay options
 */
export interface HighlightOverlayOptions {
  color?: string; // Highlight color
  opacity?: number; // Highlight opacity (0-1)
  borderWidth?: number; // Border width
  animated?: boolean; // Whether to animate
}

/**
 * Laser pointer options
 */
export interface LaserOptions {
  color?: string; // Laser pointer color, default red
  duration?: number; // Duration (milliseconds)
}

/**
 * Canvas Store - Manages all UI state of the Canvas editor
 *
 * Responsibilities:
 * - Element selection state (selected, handling, editing)
 * - Canvas viewport state (zoom, drag, ruler, grid)
 * - Toolbar and panel state
 * - Element being created
 * - Rich text editing state
 * - Format painter state
 *
 * Note: Does not manage slide data (elements, background, etc.), which is managed by Scene Context
 */

// ==================== Store Interface ====================

interface CanvasState {
  // ===== Element selection state =====
  activeElementIdList: string[]; // Currently selected element IDs
  handleElementId: string; // Element being operated (drag, resize, etc.)
  activeGroupElementId: string; // Selected child element within a group
  editingElementId: string; // Element being edited (e.g., text editing)
  hiddenElementIdList: string[]; // Hidden element IDs

  // ===== Teaching feature state =====
  spotlightElementId: string; // Element focused by spotlight
```

### lib/store/media-generation.ts
```
/**
 * Media Generation Store
 *
 * Tracks per-element media generation status (pending → generating → done/failed).
 * Drives skeleton loading in slide renderer components.
 * Persistence is handled by IndexedDB (mediaFiles table), not Zustand middleware.
 */

import { create } from 'zustand';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaGenerationStore');

// ==================== Types ====================

export type MediaTaskStatus = 'pending' | 'generating' | 'done' | 'failed';

export interface MediaTask {
  elementId: string;
  type: 'image' | 'video';
  status: MediaTaskStatus;
  prompt: string;
  params: {
    aspectRatio?: string;
    style?: string;
    duration?: number;
  };
  objectUrl?: string; // URL.createObjectURL() for rendering
  poster?: string; // Video poster objectUrl
  error?: string;
  errorCode?: string; // Structured error code (e.g. 'CONTENT_SENSITIVE')
  retryCount: number;
  stageId: string;
}

interface MediaGenerationState {
  tasks: Record<string, MediaTask>;

  // Batch enqueue
  enqueueTasks: (stageId: string, requests: MediaGenerationRequest[]) => void;

  // Status transitions
  markGenerating: (elementId: string) => void;
  markDone: (elementId: string, objectUrl: string, poster?: string) => void;
  markFailed: (elementId: string, error: string, errorCode?: string) => void;

  // Retry support
  markPendingForRetry: (elementId: string) => void;

  // Queries
  getTask: (elementId: string) => MediaTask | undefined;
  isReady: (elementId: string) => boolean;

  // Restore from IndexedDB on page load
  restoreFromDB: (stageId: string) => Promise<void>;

  // Cleanup
  clearStage: (stageId: string) => void;
```

### lib/store/index.ts
```
// Core stores
import { useCanvasStore } from './canvas';
import { useSnapshotStore } from './snapshot';
import { useKeyboardStore } from './keyboard';
import { useStageStore } from './stage';
import { useSettingsStore } from './settings';

export {
  // New architecture
  useCanvasStore,
  useStageStore,
  useSnapshotStore,
  useKeyboardStore,
  useSettingsStore,
};

// Scene Context API (for extensible scene types)
export { SceneProvider, useSceneData, useSceneSelector } from '@/lib/contexts/scene-context';
```

### lib/store/user-profile.ts
```
/**
 * User Profile Store
 * Persists avatar, nickname & bio to localStorage
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Predefined avatar options */
export const AVATAR_OPTIONS = [
  '/avatars/user.png',
  '/avatars/teacher-2.png',
  '/avatars/assist-2.png',
  '/avatars/clown-2.png',
  '/avatars/curious-2.png',
  '/avatars/note-taker-2.png',
  '/avatars/thinker-2.png',
] as const;

export interface UserProfileState {
  /** Local avatar path or data-URL (for custom uploads) */
  avatar: string;
  nickname: string;
  bio: string;
  setAvatar: (avatar: string) => void;
  setNickname: (nickname: string) => void;
  setBio: (bio: string) => void;
}

export const useUserProfileStore = create<UserProfileState>()(
  persist(
    (set) => ({
      avatar: AVATAR_OPTIONS[0],
      nickname: '',
      bio: '',
      setAvatar: (avatar) => set({ avatar }),
      setNickname: (nickname) => set({ nickname }),
      setBio: (bio) => set({ bio }),
    }),
    {
      name: 'user-profile-storage',
    },
  ),
);
```

### lib/store/snapshot.ts
```
import { create } from 'zustand';
import type { IndexableTypeArray } from 'dexie';
import { db, type Snapshot } from '@/lib/utils/database';
import { useStageStore } from './stage';
import type { Scene } from '@/lib/types/stage';

export interface SnapshotState {
  // State
  snapshotCursor: number; // Snapshot pointer
  snapshotLength: number; // Snapshot count

  // Computed
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Actions
  setSnapshotCursor: (cursor: number) => void;
  setSnapshotLength: (length: number) => void;
  initSnapshotDatabase: () => Promise<void>;
  addSnapshot: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/**
 * Snapshot store for undo/redo functionality
 * Based on PPTist's snapshot store, migrated to Zustand
 *
 * Uses IndexedDB (via Dexie) to store snapshot history
 */
export const useSnapshotStore = create<SnapshotState>((set, get) => ({
  // Initial state
  snapshotCursor: -1,
  snapshotLength: 0,

  // Computed properties
  canUndo: () => get().snapshotCursor > 0,
  canRedo: () => get().snapshotCursor < get().snapshotLength - 1,

  // Actions
  setSnapshotCursor: (cursor: number) => set({ snapshotCursor: cursor }),
  setSnapshotLength: (length: number) => set({ snapshotLength: length }),

  /**
   * Initialize snapshot database with current state
   */
  initSnapshotDatabase: async () => {
    const stageStore = useStageStore.getState();

    const newFirstSnapshot = {
      index: stageStore.getSceneIndex(stageStore.currentSceneId || ''),
      slides: JSON.parse(JSON.stringify(stageStore.scenes)),
    };
    await db.snapshots.add(newFirstSnapshot);

    set({
      snapshotCursor: 0,
      snapshotLength: 1,
    });
  },
```

### lib/store/keyboard.ts
```
import { create } from 'zustand';

export interface KeyboardState {
  ctrlKeyState: boolean;
  shiftKeyState: boolean;
  spaceKeyState: boolean;

  // Getters
  ctrlOrShiftKeyActive: () => boolean;

  // Actions
  setCtrlKeyState: (active: boolean) => void;
  setShiftKeyState: (active: boolean) => void;
  setSpaceKeyState: (active: boolean) => void;
}

export const useKeyboardStore = create<KeyboardState>((set, get) => ({
  // Initial state
  ctrlKeyState: false, // Ctrl key pressed state
  shiftKeyState: false, // Shift key pressed state
  spaceKeyState: false, // Space key pressed state

  // Getters
  ctrlOrShiftKeyActive: () => {
    const state = get();
    return state.ctrlKeyState || state.shiftKeyState;
  },

  // Actions
  setCtrlKeyState: (active) => set({ ctrlKeyState: active }),
  setShiftKeyState: (active) => set({ shiftKeyState: active }),
  setSpaceKeyState: (active) => set({ spaceKeyState: active }),
}));
```

### lib/store/settings.ts
```
/**
 * Settings Store
 * Global settings state synchronized with localStorage
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderId } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { PROVIDERS } from '@/lib/ai/providers';
import type { TTSProviderId, ASRProviderId } from '@/lib/audio/types';
import { DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('Settings');

/** Available playback speed tiers */
export const PLAYBACK_SPEEDS = [1, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface SettingsState {
  // Model selection
  providerId: ProviderId;
  modelId: string;

  // Provider configurations (unified JSON storage)
  providersConfig: ProvidersConfig;

  // TTS settings (legacy, kept for backward compatibility)
  ttsModel: string;

  // Audio settings (new unified audio configuration)
  ttsProviderId: TTSProviderId;
  ttsVoice: string;
  ttsSpeed: number;
  asrProviderId: ASRProviderId;
  asrLanguage: string;

  // Audio provider configurations
  ttsProvidersConfig: Record<
    TTSProviderId,
    {
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      isServerConfigured?: boolean;
      serverBaseUrl?: string;
    }
  >;

  asrProvidersConfig: Record<
    ASRProviderId,
    {
      apiKey: string;
      baseUrl: string;
```

### lib/store/stage.ts
```
import { create } from 'zustand';
import type { Stage, Scene, StageMode } from '@/lib/types/stage';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { ChatSession } from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('StageStore');

/** Virtual scene ID used when the user navigates to a page still being generated */
export const PENDING_SCENE_ID = '__pending__';

// ==================== Debounce Helper ====================

/**
 * Debounce function to limit how often a function is called
 * @param func Function to debounce
 * @param delay Delay in milliseconds
 */
function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, delay);
  };
}

type ToolbarState = 'design' | 'ai';

interface StageState {
  // Stage info
  stage: Stage | null;

  // Scenes
  scenes: Scene[];
  currentSceneId: string | null;

  // Chats
  chats: ChatSession[];

  // Mode
  mode: StageMode;

  // UI state
  toolbarState: ToolbarState;

  // Transient generation state (not persisted)
  generatingOutlines: SceneOutline[];

  // Persisted outlines for resume-on-refresh
  outlines: SceneOutline[];
```

### lib/utils/chat-storage.ts
```
/**
 * Chat Storage - Persist chat sessions to IndexedDB
 *
 * Independent from stage/scene storage cycle.
 * Handles serialization, truncation, and batch writes.
 */

import type { ChatSession, ChatMessageMetadata, SessionStatus } from '@/lib/types/chat';
import type { UIMessage } from 'ai';
import { db, type ChatSessionRecord } from './database';

/** Maximum messages per session to avoid IndexedDB bloat */
const MAX_MESSAGES_PER_SESSION = 200;

/**
 * Save chat sessions for a stage to IndexedDB.
 * - Active sessions are saved as 'interrupted' (streaming context lost on refresh)
 * - pendingToolCalls are cleared (runtime-only state)
 * - Messages are truncated to MAX_MESSAGES_PER_SESSION
 */
export async function saveChatSessions(stageId: string, sessions: ChatSession[]): Promise<void> {
  if (!sessions || sessions.length === 0) {
    // Delete all sessions for this stage if empty
    await db.chatSessions.where('stageId').equals(stageId).delete();
    return;
  }

  const records: ChatSessionRecord[] = sessions.map((session) => ({
    id: session.id,
    stageId,
    type: session.type,
    title: session.title,
    // Mark active sessions as interrupted (streaming context lost on refresh)
    status: (session.status === 'active' ? 'interrupted' : session.status) as SessionStatus,
    // Truncate messages and strip non-serializable data
    messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION),
    config: session.config,
    toolCalls: session.toolCalls,
    pendingToolCalls: [], // Clear runtime state
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sceneId: session.sceneId,
    lastActionIndex: session.lastActionIndex,
  }));

  await db.transaction('rw', db.chatSessions, async () => {
    // Delete old sessions for this stage, then bulk insert new ones
    await db.chatSessions.where('stageId').equals(stageId).delete();
    await db.chatSessions.bulkPut(records);
  });
}

/**
 * Load chat sessions for a stage from IndexedDB.
 * Returns sessions sorted by createdAt.
 */
export async function loadChatSessions(stageId: string): Promise<ChatSession[]> {
  const records = await db.chatSessions.where('stageId').equals(stageId).sortBy('createdAt');

  return records.map((record) => ({
```

### lib/utils/playback-storage.ts
```
/**
 * Playback Storage - Persist playback engine state to IndexedDB
 *
 * Stores minimal state needed to resume playback from a breakpoint:
 * position (sceneIndex + actionIndex) and consumed discussions.
 */

import { db } from './database';

export interface PlaybackSnapshot {
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  sceneId?: string; // Scene this snapshot belongs to; discard on mismatch
}

/**
 * Save playback state for a stage.
 * Each stage has at most one playback state record.
 */
export async function savePlaybackState(
  stageId: string,
  snapshot: PlaybackSnapshot,
): Promise<void> {
  await db.playbackState.put({
    stageId,
    sceneIndex: snapshot.sceneIndex,
    actionIndex: snapshot.actionIndex,
    consumedDiscussions: snapshot.consumedDiscussions,
    sceneId: snapshot.sceneId,
    updatedAt: Date.now(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/**
 * Load playback state for a stage.
 * Returns null if no saved state exists.
 */
export async function loadPlaybackState(stageId: string): Promise<PlaybackSnapshot | null> {
  const record = await db.playbackState.get(stageId);
  if (!record) return null;

  return {
    sceneIndex: record.sceneIndex,
    actionIndex: record.actionIndex,
    consumedDiscussions: record.consumedDiscussions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sceneId: (record as any).sceneId as string | undefined,
  };
}

/**
 * Clear playback state for a stage (e.g. on playback complete or stop).
 */
export async function clearPlaybackState(stageId: string): Promise<void> {
  await db.playbackState.delete(stageId);
}
```

### lib/utils/image-storage.ts
```
/**
 * Image Storage Utilities
 *
 * Store PDF images in IndexedDB to avoid sessionStorage 5MB limit.
 * Images are stored as Blobs for efficient storage.
 */

import { db, type ImageFileRecord } from './database';
import { nanoid } from 'nanoid';
import { createLogger } from '@/lib/logger';

const log = createLogger('ImageStorage');

/**
 * Convert base64 data URL to Blob
 */
function base64ToBlob(base64DataUrl: string): Blob {
  const parts = base64DataUrl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const base64Data = parts[1];
  const byteString = atob(base64Data);
  const arrayBuffer = new ArrayBuffer(byteString.length);
  const uint8Array = new Uint8Array(arrayBuffer);

  for (let i = 0; i < byteString.length; i++) {
    uint8Array[i] = byteString.charCodeAt(i);
  }

  return new Blob([uint8Array], { type: mimeType });
}

/**
 * Convert Blob to base64 data URL
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Store images in IndexedDB
 * Returns array of stored image IDs
 */
export async function storeImages(
  images: Array<{ id: string; src: string; pageNumber?: number }>,
): Promise<string[]> {
  const sessionId = nanoid(10);
  const storedIds: string[] = [];

  for (const img of images) {
    try {
      const blob = base64ToBlob(img.src);
      const mimeMatch = img.src.match(/data:(.*?);/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';

```

### lib/utils/create-selectors.ts
```
import { StoreApi, UseBoundStore } from 'zustand';

type WithSelectors<S> = S extends { getState: () => infer T }
  ? S & { use: { [K in keyof T]: () => T[K] } }
  : never;

export const createSelectors = <S extends UseBoundStore<StoreApi<object>>>(_store: S) => {
  const store = _store as WithSelectors<typeof _store>;
  store.use = {};
  for (const k of Object.keys(store.getState())) {
    (store.use as Record<string, () => unknown>)[k] = () => store((s) => s[k as keyof typeof s]);
  }

  return store;
};
```

### lib/utils/element.ts
```
import tinycolor from 'tinycolor2';
import { nanoid } from 'nanoid';
import type { PPTElement, PPTLineElement, Slide } from '@/lib/types/slides';

interface RotatedElementData {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
}

interface IdMap {
  [id: string]: string;
}

/**
 * 计算元素在画布中的矩形范围旋转后的新位置范围
 * @param element 元素的位置大小和旋转角度信息
 */
export const getRectRotatedRange = (element: RotatedElementData) => {
  const { left, top, width, height, rotate = 0 } = element;

  const radius = Math.sqrt(Math.pow(width, 2) + Math.pow(height, 2)) / 2;
  const auxiliaryAngle = (Math.atan(height / width) * 180) / Math.PI;

  const tlbraRadian = ((180 - rotate - auxiliaryAngle) * Math.PI) / 180;
  const trblaRadian = ((auxiliaryAngle - rotate) * Math.PI) / 180;

  const middleLeft = left + width / 2;
  const middleTop = top + height / 2;

  const xAxis = [
    middleLeft + radius * Math.cos(tlbraRadian),
    middleLeft + radius * Math.cos(trblaRadian),
    middleLeft - radius * Math.cos(tlbraRadian),
    middleLeft - radius * Math.cos(trblaRadian),
  ];
  const yAxis = [
    middleTop - radius * Math.sin(tlbraRadian),
    middleTop - radius * Math.sin(trblaRadian),
    middleTop + radius * Math.sin(tlbraRadian),
    middleTop + radius * Math.sin(trblaRadian),
  ];

  return {
    xRange: [Math.min(...xAxis), Math.max(...xAxis)],
    yRange: [Math.min(...yAxis), Math.max(...yAxis)],
  };
};

/**
 * 计算元素在画布中的矩形范围旋转后的新位置与旋转之前位置的偏离距离
 * @param element 元素的位置大小和旋转角度信息
 */
export const getRectRotatedOffset = (element: RotatedElementData) => {
  const { xRange: originXRange, yRange: originYRange } = getRectRotatedRange({
    left: element.left,
    top: element.top,
    width: element.width,
```

### lib/utils/cn.ts
```
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

### lib/utils/geometry.ts
```
import type { PPTElement } from '@/lib/types/slides';
import type { PercentageGeometry } from '@/lib/types/action';

/**
 * Calculate percentage coordinates (0-100) for an element
 *
 * @param element - PPT element
 * @param viewportSize - Viewport width base, default 1000px
 * @returns Percentage geometry info, or null if the element has no position info
 */
export function getElementPercentageGeometry(
  element: PPTElement,
  viewportSize: number = 1000,
): PercentageGeometry | null {
  // Only positioned elements have left/top/width/height
  if (
    !('left' in element) ||
    !('top' in element) ||
    !('width' in element) ||
    !('height' in element)
  ) {
    return null;
  }

  const { left, top, width, height } = element;

  // Calculate percentage coordinates (relative to viewportSize)
  const x = (left / viewportSize) * 100;
  const y = (top / (viewportSize * 0.5625)) * 100; // 16:9 ratio
  const w = (width / viewportSize) * 100;
  const h = (height / (viewportSize * 0.5625)) * 100;

  // Calculate center point
  const centerX = x + w / 2;
  const centerY = y + h / 2;

  return {
    x,
    y,
    w,
    h,
    centerX,
    centerY,
  };
}

/**
 * Find percentage geometry info by scene and element ID
 *
 * @param scene - Scene object
 * @param elementId - Element ID
 * @param viewportSize - Viewport width base, default 1000px
 * @returns Percentage geometry info, or null if element is not found or has no position info
 */
export function findElementGeometry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scene can be old or new format with different shapes
  scene: Record<string, any>,
  elementId: string,
  viewportSize: number = 1000,
): PercentageGeometry | null {
```

### lib/utils/audio-player.ts
```
/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Loads pre-generated TTS audio files from IndexedDB
 *
 */

import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('AudioPlayer');

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;

  /**
   * Play audio (from IndexedDB pre-generated cache)
   * @param audioId Audio ID
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(audioId: string): Promise<boolean> {
    try {
      // Get audio from database
      const audioRecord = await db.audioFiles.get(audioId);

      if (!audioRecord) {
        // Pre-generated audio does not exist (generation failed), skip silently
        return false;
      }

      // Stop current playback
      this.stop();

      // Create audio element
      this.audio = new Audio();

      // Set audio source
      const blobUrl = URL.createObjectURL(audioRecord.blob);
      this.audio.src = blobUrl;
      if (this.muted) this.audio.volume = 0;
      else this.audio.volume = this.volume;

      // Apply playback rate
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;

      // Set ended callback
      this.audio.addEventListener('ended', () => {
        URL.revokeObjectURL(blobUrl);
        this.onEndedCallback?.();
      });

```

### lib/utils/index.ts
```
export { cn } from './cn';
```

### lib/utils/emitter.ts
```
import mitt, { type Emitter } from 'mitt';

export const enum EmitterEvents {
  RICH_TEXT_COMMAND = 'RICH_TEXT_COMMAND',
  SYNC_RICH_TEXT_ATTRS_TO_STORE = 'SYNC_RICH_TEXT_ATTRS_TO_STORE',
  OPEN_CHART_DATA_EDITOR = 'OPEN_CHART_DATA_EDITOR',
  OPEN_LATEX_EDITOR = 'OPEN_LATEX_EDITOR',
}

export interface RichTextAction {
  command: string;
  value?: string;
}

export interface RichTextCommand {
  target?: string;
  action: RichTextAction | RichTextAction[];
}

type Events = {
  [EmitterEvents.RICH_TEXT_COMMAND]: RichTextCommand;
  [EmitterEvents.SYNC_RICH_TEXT_ATTRS_TO_STORE]: void;
  [EmitterEvents.OPEN_CHART_DATA_EDITOR]: void;
  [EmitterEvents.OPEN_LATEX_EDITOR]: void;
};

const emitter: Emitter<Events> = mitt<Events>();

export default emitter;
```

### lib/utils/model-config.ts
```
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Get current model configuration from settings store
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig } = useSettingsStore.getState();
  const modelString = `${providerId}:${modelId}`;

  // Get current provider's config
  const providerConfig = providersConfig[providerId];

  return {
    providerId,
    modelId,
    modelString,
    apiKey: providerConfig?.apiKey || '',
    baseUrl: providerConfig?.baseUrl || '',
    providerType: providerConfig?.type,
    requiresApiKey: providerConfig?.requiresApiKey,
    isServerConfigured: providerConfig?.isServerConfigured,
  };
}
```

### lib/utils/stage-storage.ts
```
/**
 * Stage Storage Manager
 *
 * Manages multiple stage data in IndexedDB
 * Each stage has its own storage key based on stageId
 */

import { Stage, Scene } from '../types/stage';
import { ChatSession } from '../types/chat';
import { db } from './database';
import { saveChatSessions, loadChatSessions, deleteChatSessions } from './chat-storage';
import { clearPlaybackState } from './playback-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('StageStorage');

export interface StageStoreData {
  stage: Stage;
  scenes: Scene[];
  currentSceneId: string | null;
  chats: ChatSession[];
}

export interface StageListItem {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Save stage data to IndexedDB
 */
export async function saveStageData(stageId: string, data: StageStoreData): Promise<void> {
  try {
    const now = Date.now();

    // Save to stages table
    await db.stages.put({
      id: stageId,
      name: data.stage.name || 'Untitled Stage',
      description: data.stage.description,
      createdAt: data.stage.createdAt || now,
      updatedAt: now,
      language: data.stage.language,
      style: data.stage.style,
      currentSceneId: data.currentSceneId || undefined,
    });

    // Delete old scenes first to avoid orphaned data
    await db.scenes.where('stageId').equals(stageId).delete();

    // Save new scenes
    if (data.scenes && data.scenes.length > 0) {
      await db.scenes.bulkPut(
        data.scenes.map((scene, index) => ({
          ...scene,
          stageId,
```

### lib/utils/database.ts
```
import Dexie, { type EntityTable } from 'dexie';
import type { Scene, SceneType, SceneContent, Whiteboard } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type {
  SessionType,
  SessionStatus,
  SessionConfig,
  ToolCallRecord,
  ToolCallRequest,
} from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import type { UIMessage } from 'ai';
import { createLogger } from '@/lib/logger';

const log = createLogger('Database');

/**
 * Legacy Snapshot type for undo/redo functionality
 * Used by useSnapshotStore
 */
export interface Snapshot {
  id?: number;
  index: number;
  slides: Scene[];
}

/**
 * MAIC Local Database
 *
 * Uses IndexedDB to store all user data locally
 * - Does not delete expired data; all data is stored permanently
 * - Uses a fixed database name
 * - Supports multi-course management
 */

// ==================== Database Table Type Definitions ====================

/**
 * Stage table - Course basic info
 */
export interface StageRecord {
  id: string; // Primary key
  name: string;
  description?: string;
  createdAt: number; // timestamp
  updatedAt: number; // timestamp
  language?: string;
  style?: string;
  currentSceneId?: string;
}

/**
 * Scene table - Scene/page data
 */
export interface SceneRecord {
  id: string; // Primary key
  stageId: string; // Foreign key -> stages.id
  type: SceneType;
  title: string;
  order: number; // Display order
```

### lib/i18n/generation.ts
```
export const generationZhCN = {
  classroom: {
    recentClassrooms: '最近学习',
    today: '今天',
    yesterday: '昨天',
    daysAgo: '天前',
    slides: '页',
    nameCopied: '课堂名称已复制',
    deleteConfirmTitle: '删除课堂',
    delete: '删除',
  },
  upload: {
    pdfSizeLimit: '支持最大50MB的PDF文件',
    generateFailed: '生成课堂失败，请重试',
    requirementPlaceholder:
      '输入你想学的任何内容，例如：\n「从零学 Python，30 分钟写出第一个程序」\n「用白板给我讲解傅里叶变换」\n「阿瓦隆桌游怎么玩」',
    requirementRequired: '请输入课程需求',
    fileTooLarge: '文件过大，请选择小于50MB的PDF文件',
  },
  generation: {
    // Progress steps (used dynamically via activeStep)
    analyzingPdf: '解析 PDF 文档',
    analyzingPdfDesc: '正在提取文档结构和内容...',
    generatingOutlines: '生成课程大纲',
    generatingOutlinesDesc: '正在构建学习路径...',
    generatingSlideContent: '生成页面内容',
    generatingSlideContentDesc: '正在创建幻灯片、测验和互动内容...',
    generatingActions: '生成教学动作',
    generatingActionsDesc: '正在编排讲解、聚焦和互动流程...',
    generationComplete: '生成完成！',
    generationFailed: '生成失败',
    generatingCourse: '正在生成课程',
    openingClassroom: '即将打开课堂...',
    outlineReady: '课程大纲已生成',
    generatingFirstPage: '首页内容生成中...',
    firstPageReady: '首页已就绪！正在打开课堂...',
    speechFailed: '语音合成失败',
    retryScene: '重试生成',
    retryingScene: '正在重新生成...',
    backToHome: '返回首页',
    sessionNotFound: '未找到生成会话',
    sessionNotFoundDesc: '请先填写课程需求开始生成流程。',
    goBackAndRetry: '返回重试',
    classroomReady: '你的个性化AI学习环境已成功生成。',
    aiWorking: 'AI智能体工作中...',
    textTruncated: '文档文本较长，已截取前 {n} 字符用于生成',
    imageTruncated: '文档含 {total} 张图片，超出上限 {max} 张，多余图片将仅以文字描述传递',
    // Agent generation
    agentGeneration: '生成课堂角色',
    agentGenerationDesc: '正在根据课程内容生成角色...',
    agentRevealTitle: '你的课堂角色',
    viewAgents: '查看角色',
    continue: '继续',
    // Outline errors
    outlineRetrying: '大纲生成异常，正在重试...',
    outlineEmptyResponse: '模型未返回有效的大纲内容，请检查模型配置后重试',
    outlineGenerateFailed: '大纲生成失败，请稍后重试',
    // Web Search
    webSearching: '网络搜索',
    webSearchingDesc: '正在搜索网络获取最新资料',
```

### lib/i18n/index.ts
```
import { defaultLocale } from './types';
export { type Locale, defaultLocale } from './types';
import { commonZhCN, commonEnUS } from './common';
import { stageZhCN, stageEnUS } from './stage';
import { chatZhCN, chatEnUS } from './chat';
import { generationZhCN, generationEnUS } from './generation';
import { settingsZhCN, settingsEnUS } from './settings';

export const translations = {
  'zh-CN': {
    ...commonZhCN,
    ...stageZhCN,
    ...chatZhCN,
    ...generationZhCN,
    ...settingsZhCN,
  },
  'en-US': {
    ...commonEnUS,
    ...stageEnUS,
    ...chatEnUS,
    ...generationEnUS,
    ...settingsEnUS,
  },
} as const;

export type TranslationKey = keyof (typeof translations)[typeof defaultLocale];
```

### lib/i18n/types.ts
```
export type Locale = 'zh-CN' | 'en-US';

export const defaultLocale: Locale = 'zh-CN';
```

### lib/i18n/common.ts
```
export const commonZhCN = {
  common: {
    you: '你',
    confirm: '确定',
    cancel: '取消',
    loading: '加载中...',
  },
  home: {
    slogan: 'Generative Learning in Multi-Agent Interactive Classroom',
    greeting: '嗨，',
  },
  toolbar: {
    languageHint: '课程将以此语言生成',
    pdfParser: '解析器',
    pdfUpload: '上传 PDF',
    removePdf: '移除文件',
    webSearchOn: '已开启',
    webSearchOff: '点击开启',
    webSearchDesc: '生成前搜索网络获取最新资料，让内容更丰富准确',
    webSearchProvider: '搜索引擎',
    webSearchNoProvider: '请在设置中配置搜索引擎 API Key',
    selectProvider: '选择模型服务商',
    configureProvider: '配置模型',
    configureProviderHint: '请先配置至少一个模型服务商才能生成课程',
    enterClassroom: '进入课堂',
    advancedSettings: '高级设置',
    ttsTitle: '语音合成',
    ttsHint: '选择 AI 教师的朗读音色',
    ttsPreview: '试听',
    ttsPreviewing: '播放中...',
  },
  export: {
    pptx: '导出 PPTX',
    resourcePack: '导出教学资源包',
    resourcePackDesc: 'PPTX + 交互式页面',
    exporting: '正在导出...',
    exportSuccess: '导出成功',
    exportFailed: '导出失败',
  },
} as const;

export const commonEnUS = {
  common: {
    you: 'You',
    confirm: 'Confirm',
    cancel: 'Cancel',
    loading: 'Loading...',
  },
  home: {
    slogan: 'Generative Learning in Multi-Agent Interactive Classroom',
    greeting: 'Hi, ',
  },
  toolbar: {
    languageHint: 'Course will be generated in this language',
    pdfParser: 'Parser',
    pdfUpload: 'Upload PDF',
    removePdf: 'Remove file',
    webSearchOn: 'Enabled',
    webSearchOff: 'Click to enable',
    webSearchDesc: 'Search the web for up-to-date information before generation',
```

### lib/i18n/chat.ts
```
export const chatZhCN = {
  chat: {
    lecture: '授课',
    noConversations: '暂无对话',
    startConversation: '输入消息开始对话',
    noMessages: '暂无消息',
    ended: '已结束',
    unknown: '未知',
    stopDiscussion: '结束讨论',
    endQA: '结束问答',
    tabs: {
      lecture: '笔记',
      chat: '对话',
    },
    lectureNotes: {
      empty: '播放课程后，笔记将在此显示',
      emptyHint: '点击播放按钮开始授课',
      pageLabel: '第 {n} 页',
      currentPage: '当前页',
    },
    badge: {
      qa: 'Q&A',
      discussion: '讨论',
      lecture: '授课',
    },
  },
  actions: {
    names: {
      spotlight: '聚光灯',
      laser: '激光笔',
      wb_open: '打开白板',
      wb_draw_text: '白板文本',
      wb_draw_shape: '白板形状',
      wb_draw_chart: '白板图表',
      wb_draw_latex: '白板公式',
      wb_draw_table: '白板表格',
      wb_draw_line: '白板线条',
      wb_clear: '清空白板',
      wb_delete: '删除元素',
      wb_close: '关闭白板',
      discussion: '课堂讨论',
    },
    status: {
      inputStreaming: '等待中',
      inputAvailable: '执行中',
      outputAvailable: '已完成',
      outputError: '错误',
      outputDenied: '已拒绝',
      running: '执行中',
      result: '已完成',
      error: '错误',
    },
  },
  agentBar: {
    readyToLearn: '准备好一起学习了吗？',
    expandedTitle: '课堂角色配置',
    configTooltip: '点击配置课堂角色',
  },
  proactiveCard: {
    discussion: '讨论',
```

### lib/i18n/settings.ts
```
export const settingsZhCN = {
  settings: {
    title: '设置',
    description: '配置应用程序设置',
    language: '语言',
    languageDesc: '选择界面语言',
    theme: '主题',
    themeDesc: '选择主题模式（浅色/深色/跟随系统）',
    themeOptions: {
      light: '浅色',
      dark: '深色',
      system: '跟随系统',
    },
    apiKey: 'API密钥',
    apiKeyDesc: '配置你的API密钥',
    apiBaseUrl: 'API端点地址',
    apiBaseUrlDesc: '配置你的API端点地址',
    apiKeyRequired: 'API密钥不能为空',
    model: '模型配置',
    modelDesc: '配置AI模型',
    modelPlaceholder: '输入或选择模型名称',
    ttsModel: 'TTS模型',
    ttsModelDesc: '配置TTS模型',
    ttsModelPlaceholder: '输入或选择TTS模型名称',
    ttsModelOptions: {
      openaiTts: 'OpenAI TTS',
      azureTts: 'Azure TTS',
    },
    testConnection: '测试连接',
    testConnectionDesc: '测试当前API配置是否可用',
    testing: '测试中...',
    agentSettings: '智能体设置',
    agentSettingsDesc: '选择参与对话的智能体。选择1个为单智能体模式，选择多个为多智能体协作模式。',
    agentMode: '智能体模式',
    agentModePreset: '预设模式',
    agentModeAuto: '自动生成',
    agentModeAutoDesc: 'AI 将根据课程内容自动生成适合的课堂角色',
    autoAgentCount: '生成数量',
    autoAgentCountDesc: '自动生成的角色数量（包含教师）',
    atLeastOneAgent: '请至少选择1个智能体',
    singleAgentMode: '单智能体模式',
    directAnswer: '直接回答',
    multiAgentMode: '多智能体模式',
    agentsCollaborating: '协作讨论',
    agentsCollaboratingCount: '已选择 {count} 个智能体协作讨论',
    maxTurns: '最大讨论轮数',
    maxTurnsDesc: '智能体之间最多讨论多少轮（每个智能体完成动作并回复算一轮）',
    priority: '优先级',
    actions: '动作',
    actionCount: '{count} 个动作',
    selectedAgent: '选中的智能体',
    selectedAgents: '选中的智能体',
    required: '必选',
    agentNames: {
      'default-1': 'AI教师',
      'default-2': 'AI助教',
      'default-3': '显眼包',
      'default-4': '好奇宝宝',
      'default-5': '笔记员',
      'default-6': '思考者',
```

### lib/i18n/stage.ts
```
export const stageZhCN = {
  stage: {
    currentScene: '当前场景',
    generating: '生成中...',
    paused: '已暂停',
    generationFailed: '生成失败',
    confirmSwitchTitle: '切换页面',
    confirmSwitchMessage: '当前话题正在进行中，切换页面将结束当前话题。确定要切换吗？',
    generatingNextPage: '场景正在生成，请稍候...',
  },
  whiteboard: {
    title: '互动白板',
    open: '打开白板',
    clear: '清空白板',
    minimize: '最小化白板',
    ready: '白板已就绪',
    readyHint: 'AI 添加元素后将在此显示',
    clearSuccess: '白板已清空',
    clearError: '清空白板失败：',
  },
  quiz: {
    title: '随堂测验',
    subtitle: '检测你的学习成果',
    questionsCount: '道题',
    totalPrefix: '共',
    pointsSuffix: '分',
    startQuiz: '开始答题',
    multipleChoiceHint: '（多选题，请选择所有正确答案）',
    inputPlaceholder: '请在此输入你的回答...',
    charCount: '字',
    yourAnswer: '你的回答：',
    notAnswered: '未作答',
    aiComment: 'AI 点评',
    singleChoice: '单选',
    multipleChoice: '多选',
    shortAnswer: '简答',
    analysis: '解析：',
    excellent: '优秀！',
    keepGoing: '继续加油！',
    needsReview: '需要复习',
    correct: '正确',
    incorrect: '错误',
    answering: '答题中',
    submitAnswers: '提交答案',
    aiGrading: 'AI 正在批改中...',
    aiGradingWait: '请稍候，正在分析你的答案',
    quizReport: '答题报告',
    retry: '重新答题',
  },
  roundtable: {
    teacher: '教师',
    you: '你',
    inputPlaceholder: '输入你的消息...',
    listening: '录音中...',
    processing: '处理中...',
    noSpeechDetected: '未检测到语音，请重试',
    discussionEnded: '讨论已结束',
    qaEnded: '问答已结束',
    thinking: '思考中',
    yourTurn: '轮到你发言了',
```

### lib/generation/json-repair.ts
```
/**
 * JSON parsing with fallback strategies for AI-generated responses.
 */

import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

export function parseJsonResponse<T>(response: string): T | null {
  // Strategy 1: Try to extract JSON from markdown code blocks (may have multiple)
  const codeBlockMatches = response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of codeBlockMatches) {
    const extracted = match[1].trim();
    // Only try if it looks like JSON (starts with { or [)
    if (extracted.startsWith('{') || extracted.startsWith('[')) {
      const result = tryParseJson<T>(extracted);
      if (result !== null) {
        log.debug('Successfully parsed JSON from code block');
        return result;
      }
    }
  }

  // Strategy 2: Try to find JSON structure directly in response (no code block)
  // Look for array or object start
  const jsonStartArray = response.indexOf('[');
  const jsonStartObject = response.indexOf('{');

  if (jsonStartArray !== -1 || jsonStartObject !== -1) {
    // Prefer the structure that appears first
    const startIndex =
      jsonStartArray === -1
        ? jsonStartObject
        : jsonStartObject === -1
          ? jsonStartArray
          : Math.min(jsonStartArray, jsonStartObject);

    // Find the matching close bracket
    let depth = 0;
    let endIndex = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < response.length; i++) {
      const char = response[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
```

### lib/generation/action-parser.ts
```
/**
 * Action Parser - converts structured JSON Array output to Action[]
 *
 * Bridges the stateless-generate parser (used for online streaming) with the
 * offline generation pipeline, producing typed Action objects that preserve
 * the original interleaving order from the LLM output.
 *
 * For complete (non-streaming) responses, uses JSON.parse with partial-json
 * fallback for robustness.
 */

import type { Action, ActionType } from '@/lib/types/action';
import { SLIDE_ONLY_ACTIONS } from '@/lib/types/action';
import { nanoid } from 'nanoid';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';
const log = createLogger('ActionParser');

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) from a response string.
 */
function stripCodeFences(text: string): string {
  // Remove opening ```json or ``` and closing ```
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
}

/**
 * Parse a complete LLM response in JSON Array format into an ordered Action[] array.
 *
 * Expected format (new):
 * [{"type":"action","name":"spotlight","params":{"elementId":"..."}},
 *  {"type":"text","content":"speech content"},...]
 *
 * Also supports legacy format:
 * [{"type":"action","tool_name":"spotlight","parameters":{"elementId":"..."}},...]
 *
 * Text items become `speech` actions; action items are converted to their
 * respective action types (spotlight, discussion, etc.).
 * The original interleaving order is preserved.
 */
export function parseActionsFromStructuredOutput(
  response: string,
  sceneType?: string,
  allowedActions?: string[],
): Action[] {
  // Step 1: Strip markdown code fences if present
  const cleaned = stripCodeFences(response.trim());

  // Step 2: Find the JSON array range
  const startIdx = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');

  if (startIdx === -1) {
    log.warn('No JSON array found in response');
    return [];
  }

  const jsonStr = endIdx > startIdx ? cleaned.slice(startIdx, endIdx + 1) : cleaned.slice(startIdx); // unclosed array — let partial-json handle it

```

### lib/generation/pipeline-types.ts
```
/**
 * Type definitions for the generation pipeline.
 */

import type { GenerationProgress } from '@/lib/types/generation';

// ==================== Agent Info ====================

/** Lightweight agent info passed to the generation pipeline */
export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  persona?: string;
}

// ==================== Cross-Page Context ====================

/** Cross-page context for maintaining speech coherence across scenes */
export interface SceneGenerationContext {
  pageIndex: number; // Current page (1-based)
  totalPages: number; // Total number of pages
  allTitles: string[]; // All page titles in order
  previousSpeeches: string[]; // Speech texts from the previous page only
}

// ==================== Generated Slide Data Interface ====================

/**
 * AI-generated slide data structure
 * Used to parse AI responses
 */
export interface GeneratedSlideData {
  elements: Array<{
    type: 'text' | 'image' | 'video' | 'shape' | 'chart' | 'latex' | 'line';
    left: number;
    top: number;
    width: number;
    height: number;
    [key: string]: unknown;
  }>;
  background?: {
    type: 'solid' | 'gradient';
    color?: string;
    gradient?: {
      type: 'linear' | 'radial';
      colors: Array<{ pos: number; color: string }>;
      rotate: number;
    };
  };
  remark?: string;
}

// ==================== Types ====================

export interface GenerationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}
```

### lib/generation/generation-pipeline.ts
```
/**
 * Two-Stage Generation Pipeline
 *
 * Barrel re-export — all symbols previously exported from this file
 * are now spread across focused sub-modules.
 */

// Types
export type {
  AgentInfo,
  SceneGenerationContext,
  GeneratedSlideData,
  GenerationResult,
  GenerationCallbacks,
  AICallFn,
} from './pipeline-types';

// Prompt formatters
export {
  buildCourseContext,
  formatAgentsForPrompt,
  formatTeacherPersonaForPrompt,
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
} from './prompt-formatters';

// JSON repair
export { parseJsonResponse, tryParseJson } from './json-repair';

// Outline generator (Stage 1)
export { generateSceneOutlinesFromRequirements, applyOutlineFallbacks } from './outline-generator';

// Scene generator (Stage 2)
export {
  generateFullScenes,
  generateSceneContent,
  generateSceneActions,
  createSceneWithActions,
} from './scene-generator';

// Scene builder (standalone)
export {
  buildSceneFromOutline,
  buildCompleteScene,
  uniquifyMediaElementIds,
} from './scene-builder';

// Pipeline runner
export { createGenerationSession, runGenerationPipeline } from './pipeline-runner';
```

### lib/generation/scene-generator.ts
```
/**
 * Stage 2: Scene content and action generation.
 *
 * Generates full scenes (slide/quiz/interactive/pbl with actions)
 * from scene outlines.
 */

import { nanoid } from 'nanoid';
import katex from 'katex';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  ScientificModel,
  PdfImage,
  ImageMapping,
} from '@/lib/types/generation';
import type { LanguageModel } from 'ai';
import type { StageStore } from '@/lib/api/stage-api';
import { createStageAPI } from '@/lib/api/stage-api';
import { generatePBLContent } from '@/lib/pbl/generate-pbl';
import { buildPrompt, PROMPT_IDS } from './prompts';
import { postProcessInteractiveHtml } from './interactive-post-processor';
import { parseActionsFromStructuredOutput } from './action-parser';
import { parseJsonResponse } from './json-repair';
import {
  buildCourseContext,
  formatAgentsForPrompt,
  formatTeacherPersonaForPrompt,
  formatImageDescription,
  formatImagePlaceholder,
} from './prompt-formatters';
import type { PPTElement, Slide, SlideBackground, SlideTheme } from '@/lib/types/slides';
import type { QuizQuestion } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type {
  AgentInfo,
  SceneGenerationContext,
  GeneratedSlideData,
  AICallFn,
  GenerationResult,
  GenerationCallbacks,
} from './pipeline-types';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

// ==================== Stage 2: Full Scenes (Two-Step) ====================

/**
 * Stage 3: Generate full scenes (parallel version)
 *
 * Two steps:
 * - Step 3.1: Outline -> Page content (slide/quiz)
 * - Step 3.2: Content + script -> Action list
 *
 * All scenes generated in parallel using Promise.all
 */
```

### lib/generation/pipeline-runner.ts
```
/**
 * Top-level pipeline orchestration.
 * Creates sessions and runs the full generation pipeline.
 */

import { nanoid } from 'nanoid';
import type { UserRequirements, GenerationSession } from '@/lib/types/generation';
import type { StageStore } from '@/lib/api/stage-api';
import { generateSceneOutlinesFromRequirements } from './outline-generator';
import { generateFullScenes } from './scene-generator';
import type { AICallFn, GenerationResult, GenerationCallbacks } from './pipeline-types';

export function createGenerationSession(requirements: UserRequirements): GenerationSession {
  return {
    id: nanoid(),
    requirements,
    progress: {
      currentStage: 1,
      overallProgress: 0,
      stageProgress: 0,
      statusMessage: '初始化中...',
      scenesGenerated: 0,
      totalScenes: 0,
    },
    startedAt: new Date(),
  };
}

// For full testing
export async function runGenerationPipeline(
  session: GenerationSession,
  store: StageStore,
  aiCall: AICallFn,
  callbacks?: GenerationCallbacks,
): Promise<GenerationResult<GenerationSession>> {
  try {
    // Stage 1: Generate Scene Outlines from Requirements
    callbacks?.onProgress?.({
      ...session.progress,
      currentStage: 1,
      overallProgress: 5,
      statusMessage: '正在分析需求，生成场景大纲...',
    });

    const outlinesResult = await generateSceneOutlinesFromRequirements(
      session.requirements,
      undefined, // No PDF text in this flow
      undefined, // No PDF images in this flow
      aiCall,
      callbacks,
    );
    if (!outlinesResult.success || !outlinesResult.data) {
      throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
    }
    session.sceneOutlines = outlinesResult.data;
    callbacks?.onStageComplete?.(1, session.sceneOutlines);

    // Stage 2: Generate Full Scenes
    callbacks?.onProgress?.({
      ...session.progress,
```

### lib/generation/interactive-post-processor.ts
```
/**
 * Interactive HTML Post-Processor
 *
 * Ported from Python's PostProcessor class (learn-your-way/concept_to_html.py:287-385)
 *
 * Handles:
 * - LaTeX delimiter conversion ($$...$$ -> \[...\], $...$ -> \(...\))
 * - KaTeX CSS/JS injection with auto-render and MutationObserver
 * - Script tag protection during LaTeX conversion
 */

/**
 * Main entry point: post-process generated interactive HTML
 * Converts LaTeX delimiters and injects KaTeX rendering resources.
 */
export function postProcessInteractiveHtml(html: string): string {
  // Convert LaTeX delimiters while protecting script tags
  let processed = convertLatexDelimiters(html);

  // Inject KaTeX resources if not already present
  if (!processed.toLowerCase().includes('katex')) {
    processed = injectKatex(processed);
  }

  return processed;
}

/**
 * Convert LaTeX delimiters while protecting <script> tags.
 *
 * - Protects script blocks from modification
 * - Converts $$...$$ to \[...\] (display math)
 * - Converts $...$ to \(...\) (inline math)
 * - Restores script blocks after conversion
 */
function convertLatexDelimiters(html: string): string {
  const scriptBlocks: string[] = [];

  // Protect script tags by replacing them with placeholders
  let processed = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, (match) => {
    scriptBlocks.push(match);
    return `__SCRIPT_BLOCK_${scriptBlocks.length - 1}__`;
  });

  // Convert display math: $$...$$ -> \[...\]
  processed = processed.replace(/\$\$([^$]+)\$\$/g, '\\[$1\\]');

  // Convert inline math: $...$ -> \(...\)
  // Use non-greedy match and exclude newlines to avoid false positives
  processed = processed.replace(/\$([^$\n]+?)\$/g, '\\($1\\)');

  // Restore script blocks using indexOf + substring (not .replace())
  // because script content may contain $ characters that .replace()
  // would interpret as special substitution patterns.
  for (let i = 0; i < scriptBlocks.length; i++) {
    const placeholder = `__SCRIPT_BLOCK_${i}__`;
    const idx = processed.indexOf(placeholder);
    if (idx !== -1) {
      processed =
        processed.substring(0, idx) +
```

### lib/generation/prompt-formatters.ts
```
/**
 * Prompt and context building utilities for the generation pipeline.
 */

import type { PdfImage } from '@/lib/types/generation';
import type { AgentInfo, SceneGenerationContext } from './pipeline-types';

/** Build a course context string for injection into action prompts */
export function buildCourseContext(ctx?: SceneGenerationContext): string {
  if (!ctx) return '';

  const lines: string[] = [];

  // Course outline with position marker
  lines.push('Course Outline:');
  ctx.allTitles.forEach((t, i) => {
    const marker = i === ctx.pageIndex - 1 ? ' ← current' : '';
    lines.push(`  ${i + 1}. ${t}${marker}`);
  });

  // Position information
  lines.push('');
  lines.push(
    'IMPORTANT: All pages belong to the SAME class session. Do NOT greet again after the first page. When referencing content from earlier pages, say "we just covered" or "as mentioned on page N" — NEVER say "last class" or "previous session" because there is no previous session.',
  );
  lines.push('');
  if (ctx.pageIndex === 1) {
    lines.push('Position: This is the FIRST page. Open with a greeting and course introduction.');
  } else if (ctx.pageIndex === ctx.totalPages) {
    lines.push('Position: This is the LAST page. Conclude the course with a summary and closing.');
    lines.push(
      'Transition: Continue naturally from the previous page. Do NOT greet or re-introduce.',
    );
  } else {
    lines.push(`Position: Page ${ctx.pageIndex} of ${ctx.totalPages} (middle of the course).`);
    lines.push(
      'Transition: Continue naturally from the previous page. Do NOT greet or re-introduce.',
    );
  }

  // Previous page speech for transition reference
  if (ctx.previousSpeeches.length > 0) {
    lines.push('');
    lines.push('Previous page speech (for transition reference):');
    const lastSpeech = ctx.previousSpeeches[ctx.previousSpeeches.length - 1];
    lines.push(`  "...${lastSpeech.slice(-150)}"`);
  }

  return lines.join('\n');
}

/** Format agent list for injection into action prompts */
export function formatAgentsForPrompt(agents?: AgentInfo[]): string {
  if (!agents || agents.length === 0) return '';

  const lines = ['Classroom Agents:'];
  for (const a of agents) {
    const personaPart = a.persona ? ` — ${a.persona}` : '';
    lines.push(`- id: "${a.id}", name: "${a.name}", role: ${a.role}${personaPart}`);
  }
```

### lib/generation/outline-generator.ts
```
/**
 * Stage 1: Generate scene outlines from user requirements.
 * Also contains outline fallback logic.
 */

import { nanoid } from 'nanoid';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type {
  UserRequirements,
  SceneOutline,
  PdfImage,
  ImageMapping,
} from '@/lib/types/generation';
import { buildPrompt, PROMPT_IDS } from './prompts';
import { formatImageDescription, formatImagePlaceholder } from './prompt-formatters';
import { parseJsonResponse } from './json-repair';
import { uniquifyMediaElementIds } from './scene-builder';
import type { AICallFn, GenerationResult, GenerationCallbacks } from './pipeline-types';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

/**
 * Generate scene outlines from user requirements
 * Now uses simplified UserRequirements with just requirement text and language
 */
export async function generateSceneOutlinesFromRequirements(
  requirements: UserRequirements,
  pdfText: string | undefined,
  pdfImages: PdfImage[] | undefined,
  aiCall: AICallFn,
  callbacks?: GenerationCallbacks,
  options?: {
    visionEnabled?: boolean;
    imageMapping?: ImageMapping;
    imageGenerationEnabled?: boolean;
    videoGenerationEnabled?: boolean;
  },
): Promise<GenerationResult<SceneOutline[]>> {
  // Build available images description for the prompt
  let availableImagesText =
    requirements.language === 'zh-CN' ? '无可用图片' : 'No images available';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (pdfImages && pdfImages.length > 0) {
    if (options?.visionEnabled && options?.imageMapping) {
      // Vision mode: split into vision images (first N) and text-only (rest)
      const allWithSrc = pdfImages.filter((img) => options.imageMapping![img.id]);
      const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = pdfImages.filter((img) => !options.imageMapping![img.id]);

      const visionDescriptions = visionSlice.map((img) =>
        formatImagePlaceholder(img, requirements.language),
      );
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
        formatImageDescription(img, requirements.language),
      );
      availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((img) => ({
```

### lib/generation/scene-builder.ts
```
/**
 * Standalone scene building and element normalization.
 * Does NOT depend on store — returns complete Scene objects.
 */

import { nanoid } from 'nanoid';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  PdfImage,
  ImageMapping,
} from '@/lib/types/generation';
import type { LanguageModel } from 'ai';
import type { Slide, SlideTheme } from '@/lib/types/slides';
import type { Scene } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import { applyOutlineFallbacks } from './outline-generator';
import { generateSceneContent, generateSceneActions } from './scene-generator';
import type { AgentInfo, SceneGenerationContext, AICallFn } from './pipeline-types';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

/**
 * Replace sequential gen_img_N / gen_vid_N IDs in outlines with globally unique IDs.
 *
 * The LLM generates sequential placeholder IDs (gen_img_1, gen_img_2, ...) which are
 * only unique within a single course. Since the media store uses elementId as key
 * without stageId scoping, identical IDs across different courses cause thumbnail
 * contamination on the homepage. Using nanoid-based IDs ensures global uniqueness.
 */
export function uniquifyMediaElementIds(outlines: SceneOutline[]): SceneOutline[] {
  const idMap = new Map<string, string>();

  // First pass: collect all sequential media IDs and assign unique replacements
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      if (!idMap.has(mg.elementId)) {
        const prefix = mg.type === 'video' ? 'gen_vid_' : 'gen_img_';
        idMap.set(mg.elementId, `${prefix}${nanoid(8)}`);
      }
    }
  }

  if (idMap.size === 0) return outlines;

  // Second pass: replace IDs in mediaGenerations
  return outlines.map((outline) => {
    if (!outline.mediaGenerations) return outline;
    return {
      ...outline,
      mediaGenerations: outline.mediaGenerations.map((mg) => ({
        ...mg,
        elementId: idMap.get(mg.elementId) || mg.elementId,
      })),
    };
  });
```

### lib/export/svg-path-parser.ts
```
import { SVGPathData } from 'svg-pathdata';
import arcToBezier from 'svg-arc-to-cubic-bezier';

const typeMap = {
  1: 'Z',
  2: 'M',
  4: 'H',
  8: 'V',
  16: 'L',
  32: 'C',
  64: 'S',
  128: 'Q',
  256: 'T',
  512: 'A',
};

/**
 * 简单解析SVG路径
 * @param d SVG path d属性
 */
export const parseSvgPath = (d: string) => {
  const pathData = new SVGPathData(d);

  const ret = pathData.commands.map((item) => {
    return { ...item, type: typeMap[item.type] };
  });
  return ret;
};

export type SvgPath = ReturnType<typeof parseSvgPath>;

/**
 * 解析SVG路径，并将圆弧（A）类型的路径转为三次贝塞尔（C）类型的路径
 * @param d SVG path d属性
 */
export const toPoints = (d: string) => {
  const pathData = new SVGPathData(d);

  const points = [];
  for (const item of pathData.commands) {
    const type = typeMap[item.type];

    if (item.type === 2 || item.type === 16) {
      points.push({
        x: item.x,
        y: item.y,
        relative: item.relative,
        type,
      });
    }
    if (item.type === 32) {
      points.push({
        x: item.x,
        y: item.y,
        curve: {
          type: 'cubic',
          x1: item.x1,
          y1: item.y1,
          x2: item.x2,
          y2: item.y2,
```

### lib/export/latex-to-omml.ts
```
import temml from 'temml';
import { mml2omml } from 'mathml2omml';
import { createLogger } from '@/lib/logger';

const log = createLogger('LatexToOmml');

/**
 * Strip MathML elements unsupported by mathml2omml (e.g. `<mpadded>`),
 * replacing them with their inner content.
 */
function stripUnsupportedMathML(mathml: string): string {
  const unsupported = ['mpadded'];
  let result = mathml;
  for (const tag of unsupported) {
    result = result.replace(new RegExp(`<${tag}[^>]*>`, 'g'), '');
    result = result.replace(new RegExp(`</${tag}>`, 'g'), '');
  }
  return result;
}

/**
 * Build <a:rPr> for math runs. PowerPoint requires Cambria Math font.
 * @param szHundredths - font size in hundredths of a point (e.g. 1200 = 12pt). Omit for no sz.
 */
function buildMathRPr(szHundredths?: number): string {
  const szAttr = szHundredths ? ` sz="${szHundredths}"` : '';
  return (
    `<a:rPr lang="en-US" i="1"${szAttr}>` +
    '<a:latin typeface="Cambria Math" panose="02040503050406030204" charset="0"/>' +
    '<a:cs typeface="Cambria Math" panose="02040503050406030204" charset="0"/>' +
    '</a:rPr>'
  );
}

/**
 * Post-process OMML for PPTX compatibility:
 * 1. Strip xmlns:w (wordprocessingml is DOCX-only, not valid in PPTX)
 * 2. Strip redundant xmlns:m (already declared at <p:sld> level)
 * 3. Inject <a:rPr> with Cambria Math font (and optional sz) into <m:r> and <m:ctrlPr>
 */
function postProcessOmml(omml: string, szHundredths?: number): string {
  let result = omml;
  const rpr = buildMathRPr(szHundredths);

  // Strip DOCX-only xmlns:w and redundant xmlns:m from <m:oMath>
  result = result.replace(/ xmlns:w="[^"]*"/g, '');
  result = result.replace(/ xmlns:m="[^"]*"/g, '');

  // Insert <a:rPr> before <m:t> inside <m:r> (only if not already present)
  result = result.replace(/<m:r>(\s*)<m:t/g, `<m:r>$1${rpr}$1<m:t`);

  // Fill empty <m:ctrlPr/> with <a:rPr>
  result = result.replace(/<m:ctrlPr\/>/g, `<m:ctrlPr>${rpr}</m:ctrlPr>`);

  // Fill empty <m:ctrlPr></m:ctrlPr> with <a:rPr>
  result = result.replace(/<m:ctrlPr><\/m:ctrlPr>/g, `<m:ctrlPr>${rpr}</m:ctrlPr>`);

  return result;
}

```

### lib/export/svg2base64.ts
```
// Convert SVG to base64 image. Reference: https://github.com/scriptex/svg64

const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const PREFIX = 'data:image/svg+xml;base64,';

const utf8Encode = (string: string) => {
  string = string.replace(/\r\n/g, '\n');
  let utftext = '';

  for (let n = 0; n < string.length; n++) {
    const c = string.charCodeAt(n);

    if (c < 128) {
      utftext += String.fromCharCode(c);
    } else if (c > 127 && c < 2048) {
      utftext += String.fromCharCode((c >> 6) | 192);
      utftext += String.fromCharCode((c & 63) | 128);
    } else {
      utftext += String.fromCharCode((c >> 12) | 224);
      utftext += String.fromCharCode(((c >> 6) & 63) | 128);
      utftext += String.fromCharCode((c & 63) | 128);
    }
  }

  return utftext;
};

const encode = (input: string) => {
  let output = '';
  let chr1, chr2, chr3, enc1, enc2, enc3, enc4;
  let i = 0;
  input = utf8Encode(input);
  while (i < input.length) {
    chr1 = input.charCodeAt(i++);
    chr2 = input.charCodeAt(i++);
    chr3 = input.charCodeAt(i++);
    enc1 = chr1 >> 2;
    enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
    enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
    enc4 = chr3 & 63;
    if (isNaN(chr2)) enc3 = enc4 = 64;
    else if (isNaN(chr3)) enc4 = 64;
    output =
      output +
      characters.charAt(enc1) +
      characters.charAt(enc2) +
      characters.charAt(enc3) +
      characters.charAt(enc4);
  }
  return output;
};

export const svg2Base64 = (element: Element) => {
  const XMLS = new XMLSerializer();
  const svg = XMLS.serializeToString(element);

  return PREFIX + encode(svg);
};
```

### lib/export/svg-arc-to-cubic-bezier.d.ts
```
declare module 'svg-arc-to-cubic-bezier' {
  interface ArcParams {
    px: number
    py: number
    cx: number
    cy: number
    rx: number
    ry: number
    xAxisRotation: number
    largeArcFlag: number
    sweepFlag: number
  }

  interface CubicBezierPoint {
    x: number
    y: number
    x1: number
    y1: number
    x2: number
    y2: number
  }

  export default function arcToBezier(params: ArcParams): CubicBezierPoint[]
}
```

### lib/export/use-export-pptx.ts
```
'use client';

import { useState, useCallback, useRef } from 'react';
import pptxgen from 'pptxgenjs';
import tinycolor from 'tinycolor2';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';

import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore, isMediaPlaceholder } from '@/lib/store/media-generation';
import { useI18n } from '@/lib/hooks/use-i18n';
import type {
  Slide,
  PPTElementOutline,
  PPTElementShadow,
  PPTElementLink,
} from '@/lib/types/slides';
import type { Scene, SlideContent } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { getElementRange, getLineElementPath, getTableSubThemeColor } from '@/lib/utils/element';
import { type AST, toAST } from '@/lib/export/html-parser';
import { type SvgPoints, toPoints, getSvgPathRange } from '@/lib/export/svg-path-parser';
import { svg2Base64 } from '@/lib/export/svg2base64';
import { latexToOmml } from '@/lib/export/latex-to-omml';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportPPTX');

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_FONT_FAMILY = 'Microsoft YaHei';

// ── Color formatting ──

function formatColor(_color: string) {
  if (!_color) {
    return { alpha: 0, color: '#000000' };
  }
  const c = tinycolor(_color);
  const alpha = c.getAlpha();
  const color = alpha === 0 ? '#ffffff' : c.setAlpha(1).toHexString();
  return { alpha, color };
}

type FormatColor = ReturnType<typeof formatColor>;

// ── HTML → pptxgenjs TextProps ──

function formatHTML(html: string, ratioPx2Pt: number) {
  const ast = toAST(html);
  let bulletFlag = false;
  let indent = 0;

  const slices: pptxgen.TextProps[] = [];

  const parse = (obj: AST[], baseStyleObj: Record<string, string> = {}) => {
    for (const item of obj) {
      const isBlockTag = 'tagName' in item && ['div', 'li', 'p'].includes(item.tagName);

      if (isBlockTag && slices.length) {
```

### lib/ai/providers.ts
```
/**
 * Unified AI Provider Configuration
 *
 * Supports multiple AI providers through Vercel AI SDK:
 * - OpenAI (native)
 * - Anthropic Claude (native)
 * - Google Gemini (native)
 * - MiniMax (Anthropic-compatible, recommended by official)
 * - OpenAI-compatible providers (DeepSeek, Kimi, GLM, SiliconFlow, Doubao, etc.)
 *
 * Sources:
 * - https://platform.openai.com/docs/models
 * - https://platform.claude.com/docs/en/about-claude/models/overview
 * - https://ai.google.dev/gemini-api/docs/models
 * - https://api-docs.deepseek.com/quick_start/pricing
 * - https://platform.moonshot.cn/docs/pricing/chat
 * - https://platform.minimaxi.com/docs/guides/text-generation
 * - https://platform.minimax.io/docs/api-reference/text-anthropic-api
 * - https://docs.bigmodel.cn/cn/guide/start/model-overview
 * - https://help.aliyun.com/zh/model-studio/models (Qwen/DashScope)
 * - https://siliconflow.cn/models
 * - https://siliconflow.cn/pricing
 * - https://www.volcengine.com/docs/82379/1330310
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type {
  ProviderId,
  ProviderConfig,
  ModelInfo,
  ModelConfig,
  ThinkingConfig,
} from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';
// NOTE: Do NOT import thinking-context.ts here — it uses node:async_hooks
// which is server-only, and this file is also used on the client via
// settings.ts. The thinking context is read from globalThis instead
// (set by thinking-context.ts at module load time on the server).

const log = createLogger('AIProviders');

// Re-export types for backward compatibility
export type { ProviderId, ProviderConfig, ModelInfo, ModelConfig };

/**
 * Provider registry
 */
export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    icon: '/logos/openai.svg',
    models: [
      {
```

### lib/ai/thinking-context.ts
```
/**
 * Async-context carrier for per-request ThinkingConfig.
 *
 * callLLM / streamLLM wrap each AI SDK call in thinkingContext.run()
 * so that the custom fetch wrapper in providers.ts can read the
 * current thinking preference and inject vendor-specific body params.
 *
 * IMPORTANT: This module uses node:async_hooks which is server-only.
 * providers.ts must NOT import this module directly (it's also used
 * on the client via settings.ts). Instead, providers.ts reads the
 * context via globalThis.__thinkingContext, which is set here at
 * module load time and guaranteed to be available before any fetch
 * wrapper runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ThinkingConfig } from '@/lib/types/provider';

export const thinkingContext = new AsyncLocalStorage<ThinkingConfig | undefined>();

// Expose on globalThis so providers.ts can access the store without
// importing this module (which would pull node:async_hooks into the
// client bundle via the settings.ts → providers.ts import chain).
(globalThis as Record<string, unknown>).__thinkingContext = thinkingContext;
```

### lib/ai/llm.ts
```
/**
 * Unified LLM Call Layer
 *
 * All LLM interactions should go through callLLM / streamLLM.
 */

import { generateText, streamText } from 'ai';
import type { GenerateTextResult, StreamTextResult } from 'ai';
import { createLogger } from '@/lib/logger';
import { PROVIDERS } from './providers';
import { thinkingContext } from './thinking-context';
import type { ProviderType, ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
const log = createLogger('LLM');

// Re-export for external use
export type { ThinkingConfig } from '@/lib/types/provider';

// Re-export the parameter types accepted by AI SDK
type GenerateTextParams = Parameters<typeof generateText>[0];
type StreamTextParams = Parameters<typeof streamText>[0];

function _extractRequestInfo(params: GenerateTextParams | StreamTextParams) {
  const tools = params.tools ? Object.keys(params.tools as Record<string, unknown>) : undefined;

  const p = params as Record<string, unknown>;
  return {
    system: p.system as string | undefined,
    prompt: p.prompt as string | undefined,
    messages: p.messages as unknown[] | undefined,
    tools,
    maxOutputTokens: p.maxOutputTokens as number | undefined,
  };
}

function getModelId(params: GenerateTextParams | StreamTextParams): string {
  const m = params.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'modelId' in m) return (m as { modelId: string }).modelId;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Thinking / Reasoning Adapter
//
// Builds a lookup table from PROVIDERS at module load time, then uses it to
// map a unified ThinkingConfig into provider-specific providerOptions.
// Currently handles: openai (native), anthropic (native), google (native).
// OpenAI-compatible providers (DeepSeek, Qwen, Kimi, GLM, etc.) are NOT
// handled — their vendor-specific thinking params can't be reliably passed
// through Vercel AI SDK's createOpenAI.
// ---------------------------------------------------------------------------

interface ModelThinkingInfo {
  providerType: ProviderType;
  thinking?: ThinkingCapability;
}

/** Model ID → provider type + thinking capability (built once at module load) */
const MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const map = new Map<string, ModelThinkingInfo>();
```

### lib/storage/index.ts
```
import { NoopStorageProvider } from './providers/noop';
import type { StorageProvider } from './types';

let _provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (!_provider) {
    _provider = new NoopStorageProvider();
  }
  return _provider;
}

export type { StorageProvider, StorageType } from './types';
```

### lib/storage/types.ts
```
export type StorageType = 'media' | 'poster' | 'audio';

export interface StorageProvider {
  /** Upload blob to storage. Returns the public URL. Skips if already exists (dedup). */
  upload(hash: string, blob: Buffer, type: StorageType, mimeType?: string): Promise<string>;
  /** Check if a key already exists in storage. */
  exists(hash: string, type: StorageType): Promise<boolean>;
  /** Build the public download URL for a given hash. */
  getUrl(hash: string, type: StorageType): string;
  /** Batch check which hashes exist. Returns set of existing hashes. */
  batchExists(hashes: string[], type: StorageType): Promise<Set<string>>;
}
```

### lib/server/provider-config.ts
```
/**
 * Server-side Provider Configuration
 *
 * Loads provider configs from YAML (primary) + environment variables (fallback).
 * Keys never leave the server — only provider IDs and metadata are exposed via API.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createLogger } from '@/lib/logger';

const log = createLogger('ServerProviderConfig');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerProviderEntry {
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  proxy?: string;
}

interface ServerConfig {
  providers: Record<string, ServerProviderEntry>;
  tts: Record<string, ServerProviderEntry>;
  asr: Record<string, ServerProviderEntry>;
  pdf: Record<string, ServerProviderEntry>;
  image: Record<string, ServerProviderEntry>;
  video: Record<string, ServerProviderEntry>;
  webSearch: Record<string, ServerProviderEntry>;
}

// ---------------------------------------------------------------------------
// Env-var prefix mappings
// ---------------------------------------------------------------------------

const LLM_ENV_MAP: Record<string, string> = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google',
  DEEPSEEK: 'deepseek',
  QWEN: 'qwen',
  KIMI: 'kimi',
  MINIMAX: 'minimax',
  GLM: 'glm',
  SILICONFLOW: 'siliconflow',
  DOUBAO: 'doubao',
};

const TTS_ENV_MAP: Record<string, string> = {
  TTS_OPENAI: 'openai-tts',
  TTS_AZURE: 'azure-tts',
  TTS_GLM: 'glm-tts',
  TTS_QWEN: 'qwen-tts',
};

const ASR_ENV_MAP: Record<string, string> = {
```

### lib/server/classroom-job-store.ts
```
import { promises as fs } from 'fs';
import path from 'path';
import type {
  ClassroomGenerationProgress,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import {
  CLASSROOM_JOBS_DIR,
  ensureClassroomJobsDir,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';

export type ClassroomGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ClassroomGenerationJob {
  id: string;
  status: ClassroomGenerationJobStatus;
  step: ClassroomGenerationStep | 'queued' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputSummary: {
    requirementPreview: string;
    language: string;
    hasPdf: boolean;
    pdfTextLength: number;
    pdfImageCount: number;
  };
  scenesGenerated: number;
  totalScenes?: number;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
  };
  error?: string;
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    language: input.language || 'zh-CN',
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
  };
}

/** Simple per-job mutex to serialize read-modify-write on the same job file. */
const jobLocks = new Map<string, Promise<void>>();
```

### lib/server/ssrf-guard.ts
```
/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs to prevent requests to internal/private network addresses.
 * Used by any API route that fetches a user-supplied URL server-side.
 */

/** Check if hostname is in the 172.16.0.0 - 172.31.255.255 private range */
function isPrivate172(hostname: string): boolean {
  if (!hostname.startsWith('172.')) return false;
  const second = parseInt(hostname.split('.')[1], 10);
  return second >= 16 && second <= 31;
}

/**
 * Validate a URL against SSRF attacks.
 * Returns null if the URL is safe, or an error message string if blocked.
 */
export function validateUrlForSSRF(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP(S) URLs are allowed';
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    isPrivate172(hostname) ||
    hostname.endsWith('.local') ||
    hostname.startsWith('fd') ||
    hostname.startsWith('fe80')
  ) {
    return 'Local/private network URLs are not allowed';
  }

  return null;
}
```

### lib/server/classroom-job-runner.ts
```
import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      await markClassroomGenerationJobRunning(jobId);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
```

### lib/server/classroom-generation.ts
```
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
} from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { createLogger } from '@/lib/logger';
import { parseModelString } from '@/lib/ai/providers';
import { resolveApiKey } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { persistClassroom } from '@/lib/server/classroom-storage';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  language?: string;
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
```

### lib/server/proxy-fetch.ts
```
/**
 * Proxy-aware fetch for server-side use.
 *
 * Automatically routes requests through HTTP/HTTPS proxy when
 * the standard environment variables are set:
 *   - https_proxy / HTTPS_PROXY
 *   - http_proxy / HTTP_PROXY
 *
 * Node.js's built-in fetch does NOT respect these env vars,
 * so we use undici's ProxyAgent when a proxy is configured.
 *
 * Usage: import { proxyFetch } from '@/lib/server/proxy-fetch';
 *        const res = await proxyFetch('https://api.openai.com/v1/...', { ... });
 */

import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { createLogger } from '@/lib/logger';

const log = createLogger('ProxyFetch');

function getProxyUrl(): string | undefined {
  return (
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    undefined
  );
}

let cachedAgent: ProxyAgent | null = null;
let cachedProxyUrl: string | undefined;

function getProxyAgent(): ProxyAgent | undefined {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return undefined;

  // Reuse agent if proxy URL hasn't changed
  if (cachedAgent && cachedProxyUrl === proxyUrl) {
    return cachedAgent;
  }

  cachedAgent = new ProxyAgent(proxyUrl);
  cachedProxyUrl = proxyUrl;
  return cachedAgent;
}

/**
 * Drop-in replacement for fetch() that respects proxy env vars.
 * Falls back to global fetch when no proxy is configured.
 */
export async function proxyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const agent = getProxyAgent();
  const url = typeof input === 'string' ? input : input.toString();

  if (!agent) {
    log.info('No proxy configured, using direct fetch for:', url.slice(0, 80));
    return fetch(input, init);
  }

```

### lib/server/resolve-model.ts
```
/**
 * Shared model resolution utilities for API routes.
 *
 * Extracts the repeated parseModelString → resolveApiKey → resolveBaseUrl →
 * resolveProxy → getModel boilerplate into a single call.
 */

import type { NextRequest } from 'next/server';
import { getModel, parseModelString, type ModelWithInfo } from '@/lib/ai/providers';
import { resolveApiKey, resolveBaseUrl, resolveProxy } from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

export interface ResolvedModel extends ModelWithInfo {
  /** Original model string (e.g. "openai/gpt-4o-mini") */
  modelString: string;
}

/**
 * Resolve a language model from explicit parameters.
 *
 * Use this when model config comes from the request body.
 */
export function resolveModel(params: {
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  requiresApiKey?: boolean;
}): ResolvedModel {
  const modelString = params.modelString || process.env.DEFAULT_MODEL || 'gpt-4o-mini';
  const { providerId, modelId } = parseModelString(modelString);

  const clientBaseUrl = params.baseUrl || undefined;
  if (clientBaseUrl && process.env.NODE_ENV === 'production') {
    const ssrfError = validateUrlForSSRF(clientBaseUrl);
    if (ssrfError) {
      throw new Error(ssrfError);
    }
  }

  const apiKey = clientBaseUrl
    ? params.apiKey || ''
    : resolveApiKey(providerId, params.apiKey || '');
  const baseUrl = clientBaseUrl ? clientBaseUrl : resolveBaseUrl(providerId, params.baseUrl);
  const proxy = resolveProxy(providerId);
  const { model, modelInfo } = getModel({
    providerId,
    modelId,
    apiKey,
    baseUrl,
    proxy,
    providerType: params.providerType as 'openai' | 'anthropic' | 'google' | undefined,
    requiresApiKey: params.requiresApiKey,
  });

  return { model, modelInfo, modelString };
}

/**
 * Resolve a language model from standard request headers.
```

### lib/server/classroom-storage.ts
```
import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

```

### lib/server/api-response.ts
```
import { NextResponse } from 'next/server';

export const API_ERROR_CODES = {
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  MISSING_API_KEY: 'MISSING_API_KEY',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_URL: 'INVALID_URL',
  REDIRECT_NOT_ALLOWED: 'REDIRECT_NOT_ALLOWED',
  CONTENT_SENSITIVE: 'CONTENT_SENSITIVE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  GENERATION_FAILED: 'GENERATION_FAILED',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  PARSE_FAILED: 'PARSE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export interface ApiErrorBody {
  success: false;
  errorCode: ApiErrorCode;
  error: string;
  details?: string;
}

export function apiError(
  code: ApiErrorCode,
  status: number,
  error: string,
  details?: string,
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    {
      success: false as const,
      errorCode: code,
      error,
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export function apiSuccess<T extends Record<string, unknown>>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, ...data }, { status });
}
```

### lib/web-search/tavily.ts
```
/**
 * Tavily Web Search Integration
 *
 * Uses raw REST API via proxyFetch for reliable proxy support.
 * Tavily search endpoint: POST https://api.tavily.com/search
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * Search the web using Tavily REST API and return structured results.
 */
export async function searchWithTavily(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 5 } = params;

  const res = await proxyFetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: 'basic',
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Tavily API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as {
    answer?: string;
    query: string;
    response_time: number;
    results: Array<{
      title: string;
      url: string;
      content: string;
      score: number;
    }>;
  };

  const sources: WebSearchSource[] = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }));

```

### lib/web-search/constants.ts
```
/**
 * Web Search Provider Constants
 */

import type { WebSearchProviderId, WebSearchProviderConfig } from './types';

/**
 * Web Search Provider Registry
 */
export const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderId, WebSearchProviderConfig> = {
  tavily: {
    id: 'tavily',
    name: 'Tavily',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.tavily.com',
  },
};

/**
 * Get all available web search providers
 */
export function getAllWebSearchProviders(): WebSearchProviderConfig[] {
  return Object.values(WEB_SEARCH_PROVIDERS);
}
```

### lib/web-search/types.ts
```
/**
 * Web Search Provider Type Definitions
 */

/**
 * Web Search Provider IDs
 */
export type WebSearchProviderId = 'tavily';

/**
 * Web Search Provider Configuration
 */
export interface WebSearchProviderConfig {
  id: WebSearchProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  icon?: string;
}
```

### lib/hooks/use-order-element.ts
```
import type { PPTElement } from '@/lib/types/slides';

export function useOrderElement() {
  /**
   * Get the z-order range of grouped elements
   * @param elementList All elements on the page
   * @param combineElementList Grouped elements list
   */
  const getCombineElementLevelRange = (
    elementList: PPTElement[],
    combineElementList: PPTElement[],
  ) => {
    return {
      minLevel: elementList.findIndex((_element) => _element.id === combineElementList[0].id),
      maxLevel: elementList.findIndex(
        (_element) => _element.id === combineElementList[combineElementList.length - 1].id,
      ),
    };
  };

  /**
   * Move up one layer
   * @param elementList All elements on the page
   * @param element The element being operated on
   */
  const moveUpElement = (elementList: PPTElement[], element: PPTElement) => {
    const copyOfElementList: PPTElement[] = JSON.parse(JSON.stringify(elementList));

    // If the element is a group member, all group members must be moved together
    if (element.groupId) {
      // Get all group members and their z-order range
      const combineElementList = copyOfElementList.filter(
        (_element) => _element.groupId === element.groupId,
      );
      const { minLevel, maxLevel } = getCombineElementLevelRange(elementList, combineElementList);

      // Already at the top level, cannot move further
      const nextElement = copyOfElementList[maxLevel + 1];
      const movedElementList = copyOfElementList.splice(minLevel, combineElementList.length);

      if (nextElement.groupId) {
        const nextCombineElementList = copyOfElementList.filter(
          (_element) => _element.groupId === nextElement.groupId,
        );
        copyOfElementList.splice(minLevel + nextCombineElementList.length, 0, ...movedElementList);
      } else copyOfElementList.splice(minLevel + 1, 0, ...movedElementList);
    }

    // If the element is not a group member
    else {
      // Get the element's z-level in the list
      const level = elementList.findIndex((item) => item.id === element.id);

      // Already at the top level, cannot move further
      if (level === elementList.length - 1) return;

      // Get the element above, remove this element from the list (cache removed element).
      // If the above element is in a group, insert above that group.
      // If the above element is not in any group, insert above that element.
      const nextElement = copyOfElementList[level + 1];
```

### lib/hooks/use-theme.tsx
```
'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light');

  const resolvedTheme = theme === 'system' ? systemTheme : theme;

  // Hydrate from localStorage after mount (avoids SSR mismatch)
  /* eslint-disable react-hooks/set-state-in-effect -- Hydration from localStorage must happen in effect */
  useEffect(() => {
    const stored = localStorage.getItem('theme') as Theme | null;
    if (stored && ['light', 'dark', 'system'].includes(stored)) {
      setThemeState(stored);
    }
    setSystemTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Apply theme to document
  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [resolvedTheme]);

  // Listen to system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      setSystemTheme(mediaQuery.matches ? 'dark' : 'light');
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Save theme to localStorage
  const handleSetTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, resolvedTheme }}>
      {children}
```

### lib/hooks/use-slide-background-style.ts
```
import { useMemo } from 'react';
import type { SlideBackground } from '@/lib/types/slides';

/**
 * Convert slide background data to CSS styles
 */
export function useSlideBackgroundStyle(background: SlideBackground | undefined) {
  const backgroundStyle = useMemo<React.CSSProperties>(() => {
    if (!background) return { backgroundColor: '#fff' };

    const { type, color, image, gradient } = background;

    // Solid color background
    if (type === 'solid') return { backgroundColor: color };

    // Image background mode
    // Includes: background image, background size, whether to repeat
    if (type === 'image' && image) {
      const { src, size } = image;
      if (!src) return { backgroundColor: '#fff' };
      if (size === 'repeat') {
        return {
          backgroundImage: `url(${src})`,
          backgroundRepeat: 'repeat',
          backgroundSize: 'contain',
        };
      }
      return {
        backgroundImage: `url(${src})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: size || 'cover',
      };
    }

    // Gradient background
    if (type === 'gradient' && gradient) {
      const { type, colors, rotate } = gradient;
      const list = colors.map((item) => `${item.color} ${item.pos}%`);

      if (type === 'radial') {
        return { backgroundImage: `radial-gradient(${list.join(',')})` };
      }
      return {
        backgroundImage: `linear-gradient(${rotate}deg, ${list.join(',')})`,
      };
    }

    return { backgroundColor: '#fff' };
  }, [background]);

  return {
    backgroundStyle,
  };
}
```

### lib/hooks/use-audio-recorder.ts
```
import { useState, useRef, useCallback } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('AudioRecorder');

// TypeScript declarations for Web Speech API
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API not typed in lib.dom
    SpeechRecognition: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API not typed in lib.dom
    webkitSpeechRecognition: any;
  }
}

export interface UseAudioRecorderOptions {
  onTranscription?: (text: string) => void;
  onError?: (error: string) => void;
}

export function useAudioRecorder(options: UseAudioRecorderOptions = {}) {
  const { onTranscription, onError } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API not typed
  const speechRecognitionRef = useRef<any>(null);

  // Send audio to server for transcription
  const transcribeAudio = useCallback(
    async (audioBlob: Blob) => {
      setIsProcessing(true);

      try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        // Get current ASR configuration from settings store
        // Note: This requires importing useSettingsStore in browser context
        if (typeof window !== 'undefined') {
          const { useSettingsStore } = await import('@/lib/store/settings');
          const { asrProviderId, asrLanguage, asrProvidersConfig } = useSettingsStore.getState();

          formData.append('providerId', asrProviderId);
          formData.append('language', asrLanguage);

          // Append API key and base URL if configured
          const providerConfig = asrProvidersConfig?.[asrProviderId];
          if (providerConfig?.apiKey?.trim()) {
            formData.append('apiKey', providerConfig.apiKey);
          }
          if (providerConfig?.baseUrl?.trim()) {
            formData.append('baseUrl', providerConfig.baseUrl);
          }
        }
```

### lib/hooks/use-history-snapshot.ts
```
import { useCallback } from 'react';
import { useSnapshotStore } from '@/lib/store/snapshot';

/**
 * Hook for managing history snapshots (undo/redo)
 *
 * Usage:
 * ```tsx
 * const { addHistorySnapshot, canUndo, canRedo, undo, redo } = useHistorySnapshot();
 *
 * // After making changes
 * await addHistorySnapshot();
 *
 * // Undo/Redo
 * if (canUndo) await undo();
 * if (canRedo) await redo();
 * ```
 */
export function useHistorySnapshot() {
  const addSnapshot = useSnapshotStore((state) => state.addSnapshot);
  const undo = useSnapshotStore((state) => state.undo);
  const redo = useSnapshotStore((state) => state.redo);
  const canUndo = useSnapshotStore((state) => state.canUndo);
  const canRedo = useSnapshotStore((state) => state.canRedo);

  /**
   * Add a snapshot to the history
   * Call this after any significant state change that should be undoable
   */
  const addHistorySnapshot = useCallback(async () => {
    await addSnapshot();
  }, [addSnapshot]);

  return {
    addHistorySnapshot,
    undo,
    redo,
    canUndo: canUndo(),
    canRedo: canRedo(),
  };
}
```

### lib/hooks/use-canvas-operations.ts
```
/**
 * Canvas Element Operations Hook
 *
 * Provides convenient element CRUD methods to avoid repetitive definitions in each component
 *
 * @example
 * function MyComponent() {
 *   const { addElement, updateElement, deleteElement } = useCanvasOperations();
 *
 *   const handleAdd = () => {
 *     addElement({
 *       id: 'new-1',
 *       type: 'text',
 *       // ...
 *     });
 *   };
 * }
 */

import { useSceneData, useSceneSelector } from '@/lib/contexts/scene-context';
import {
  useCanvasStore,
  type SpotlightOptions,
  type HighlightOverlayOptions,
} from '@/lib/store/canvas';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, Slide } from '@/lib/types/slides';
import { useCallback, useMemo } from 'react';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { toast } from 'sonner';
import { ElementAlignCommands, ElementOrderCommands } from '@/lib/types/edit';
import { getElementListRange } from '@/lib/utils/element';
import { useOrderElement } from './use-order-element';
import { nanoid } from 'nanoid';

type PPTElementKey = keyof PPTElement;

interface RemovePropData {
  id: string;
  propName: PPTElementKey | PPTElementKey[];
}

interface UpdateElementData {
  id: string | string[];
  props: Partial<PPTElement>;
  slideId?: string;
}

export function useCanvasOperations() {
  const { updateSceneData } = useSceneData<SlideContent>();
  const currentSlide = useSceneSelector<SlideContent, Slide>((content) => content.canvas);

  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeElementList = useMemo(
    () => currentSlide.elements.filter((el) => activeElementIdList.includes(el.id)),
    [currentSlide.elements, activeElementIdList],
  );
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const handleElementId = useCanvasStore.use.handleElementId();
```

### lib/hooks/use-streaming-text.ts
```
import { useState, useEffect, useCallback, useRef } from 'react';

export interface StreamingTextOptions {
  text: string;
  speed?: number; // characters/second, default 30
  onComplete?: () => void;
  enabled?: boolean; // whether to enable streaming, default true
}

export interface StreamingTextResult {
  displayedText: string;
  isStreaming: boolean;
  skip: () => void;
  reset: () => void;
}

/**
 * Streaming Text Hook
 *
 * Implements a character-by-character text display effect
 *
 * @param options - Configuration options
 * @returns Streaming text state and control functions
 */
export function useStreamingText(options: StreamingTextOptions): StreamingTextResult {
  const { text, speed = 30, onComplete, enabled = true } = options;

  const [displayedText, setDisplayedText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const frameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const lastIndexRef = useRef(0);

  /**
   * Skip streaming animation and display all text immediately
   */
  const skip = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setDisplayedText(text);
    setIsStreaming(false);
    startTimeRef.current = null;
    lastIndexRef.current = text.length;
    onComplete?.();
  }, [text, onComplete]);

  /**
   * Reset streaming state
   */
  const reset = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setDisplayedText('');
    setIsStreaming(false);
    startTimeRef.current = null;
```

### lib/hooks/use-draft-cache.ts
```
'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface UseDraftCacheOptions {
  key: string;
  debounceMs?: number;
}

interface UseDraftCacheReturn<T> {
  cachedValue: T | undefined;
  updateCache: (value: T) => void;
  clearCache: () => void;
}

export function useDraftCache<T>({
  key,
  debounceMs = 500,
}: UseDraftCacheOptions): UseDraftCacheReturn<T> {
  const [cachedValue] = useState<T | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        return JSON.parse(raw) as T;
      }
    } catch {
      /* ignore parse errors */
    }
    return undefined;
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = useRef<T | undefined>(undefined);
  const keyRef = useRef(key);

  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const flushPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingValueRef.current !== undefined) {
      try {
        localStorage.setItem(keyRef.current, JSON.stringify(pendingValueRef.current));
      } catch {
        /* ignore quota errors */
      }
      pendingValueRef.current = undefined;
    }
  }, []);

  const updateCache = useCallback(
    (value: T) => {
      pendingValueRef.current = value;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
```

### lib/hooks/use-browser-asr.ts
```
/**
 * Browser Native ASR (Speech Recognition) Hook
 * Uses Web Speech API for client-side speech recognition
 * Completely free, no API key required
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('BrowserASR');

// Note: Window.SpeechRecognition declaration is in components/ai-elements/prompt-input.tsx

export type ASRErrorCode =
  | 'not-supported'
  | 'no-speech'
  | 'audio-capture'
  | 'not-allowed'
  | 'network'
  | 'aborted'
  | 'unknown';

export interface UseBrowserASROptions {
  onTranscription?: (text: string) => void;
  onError?: (errorCode: ASRErrorCode) => void;
  language?: string;
  continuous?: boolean;
  interimResults?: boolean;
}

export function useBrowserASR(options: UseBrowserASROptions = {}) {
  const {
    onTranscription,
    onError,
    language = 'zh-CN',
    continuous = false,
    interimResults = false,
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API SpeechRecognition not typed
  const recognitionRef = useRef<any>(null);

  // Use refs for callbacks to avoid stale closures in recognition event handlers
  const onTranscriptionRef = useRef(onTranscription);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptionRef.current = onTranscription;
    onErrorRef.current = onError;
  }, [onTranscription, onError]);

  // SSR-safe support detection
  const [isSupported] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  );

```

### lib/hooks/use-i18n.tsx
```
'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Locale, translations, defaultLocale } from '@/lib/i18n';

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
};

const LOCALE_STORAGE_KEY = 'locale';
const VALID_LOCALES: Locale[] = ['zh-CN', 'en-US'];

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  // Hydrate from localStorage after mount (avoids SSR mismatch)
  /* eslint-disable react-hooks/set-state-in-effect -- Hydration from localStorage must happen in effect */
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && VALID_LOCALES.includes(stored as Locale)) {
        setLocaleState(stored as Locale);
        return;
      }
      const detected = navigator.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
      localStorage.setItem(LOCALE_STORAGE_KEY, detected);
      setLocaleState(detected);
    } catch {
      // localStorage unavailable, keep default
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
  };

  const t = (key: string): string => {
    const keys = key.split('.');
    let value: unknown = translations[locale];
    for (const k of keys) {
      value = (value as Record<string, unknown>)?.[k];
    }
    return (typeof value === 'string' ? value : undefined) ?? key;
  };

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
```

### lib/hooks/use-browser-tts.ts
```
/**
 * Browser Native TTS (Text-to-Speech) Hook
 * Uses Web Speech API for client-side text-to-speech
 * Completely free, no API key required
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// Note: Window.SpeechSynthesis declaration is already in the global scope

export interface UseBrowserTTSOptions {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
  rate?: number; // 0.1 to 10
  pitch?: number; // 0 to 2
  volume?: number; // 0 to 1
  lang?: string; // e.g., 'zh-CN', 'en-US'
}

export function useBrowserTTS(options: UseBrowserTTSOptions = {}) {
  const {
    onStart,
    onEnd,
    onError,
    rate = 1.0,
    pitch = 1.0,
    volume = 1.0,
    lang = 'zh-CN',
  } = options;

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Load available voices
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      return;
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setAvailableVoices(voices);
    };

    loadVoices();

    // Some browsers load voices asynchronously
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    return () => {
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);
```

### lib/hooks/use-scene-generator.ts
```
'use client';

import { useCallback, useRef } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type { SceneOutline, PdfImage, ImageMapping } from '@/lib/types/generation';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { Scene } from '@/lib/types/stage';
import type { Action, SpeechAction } from '@/lib/types/action';
import type { TTSProviderId } from '@/lib/audio/types';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneGenerator');
const TTS_MAX_TEXT_LENGTH: Partial<Record<TTSProviderId, number>> = {
  'glm-tts': 1024,
};

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
}

export function splitLongSpeechText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized || normalized.length <= maxLength) return [normalized];

  const units = normalized
    .split(/(?<=[。！？!?；;：:\n])/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const pushChunk = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
  };

  const appendUnit = (unit: string) => {
    if (!current) {
      current = unit;
      return;
    }
    if ((current + unit).length <= maxLength) {
      current += unit;
      return;
    }
```

### lib/audio/tts-providers.ts
```
/**
 * TTS (Text-to-Speech) Provider Implementation
 *
 * Factory pattern for routing TTS requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - OpenAI TTS: https://platform.openai.com/docs/guides/text-to-speech
 * - Azure TTS: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech
 * - GLM TTS: https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts
 * - Qwen TTS: https://bailian.console.aliyun.com/
 * - Browser Native: Web Speech API (client-side only)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to TTSProviderId in lib/audio/types.ts
 *    Example: | 'elevenlabs-tts'
 *
 * 2. Add provider configuration to lib/audio/constants.ts
 *    Example:
 *    'elevenlabs-tts': {
 *      id: 'elevenlabs-tts',
 *      name: 'ElevenLabs',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.elevenlabs.io/v1',
 *      icon: '/elevenlabs.svg',
 *      voices: [...],
 *      supportedFormats: ['mp3', 'pcm'],
 *      speedRange: { min: 0.5, max: 2.0, default: 1.0 }
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function generateXxxTTS(config, text): Promise<TTSGenerationResult>
 *    - Validate config and build API request
 *    - Handle API authentication (apiKey, headers)
 *    - Convert provider-specific parameters (voice, speed, format)
 *    - Return { audio: Uint8Array, format: string }
 *
 *    Example:
 *    async function generateElevenLabsTTS(
 *      config: TTSModelConfig,
 *      text: string
 *    ): Promise<TTSGenerationResult> {
 *      const baseUrl = config.baseUrl || TTS_PROVIDERS['elevenlabs-tts'].defaultBaseUrl;
 *
 *      const response = await fetch(`${baseUrl}/text-to-speech/${config.voice}`, {
 *        method: 'POST',
 *        headers: {
 *          'xi-api-key': config.apiKey!,
 *          'Content-Type': 'application/json',
 *        },
 *        body: JSON.stringify({
 *          text,
 *          model_id: 'eleven_monolingual_v1',
 *          voice_settings: {
 *            stability: 0.5,
 *            similarity_boost: 0.5,
 *          }
 *        }),
 *      });
```

### lib/audio/asr-providers.ts
```
/**
 * ASR (Automatic Speech Recognition) Provider Implementation
 *
 * Factory pattern for routing ASR requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - OpenAI Whisper: https://platform.openai.com/docs/guides/speech-to-text
 * - Browser Native: Web Speech API (https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
 * - Qwen ASR: https://bailian.console.aliyun.com/
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to ASRProviderId in lib/audio/types.ts
 *    Example: | 'assemblyai-asr'
 *
 * 2. Add provider configuration to lib/audio/constants.ts
 *    Example:
 *    'assemblyai-asr': {
 *      id: 'assemblyai-asr',
 *      name: 'AssemblyAI',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.assemblyai.com/v2',
 *      icon: '/assemblyai.svg',
 *      supportedLanguages: ['en', 'es', 'fr', 'de', 'auto'],
 *      supportedFormats: ['mp3', 'wav', 'flac', 'm4a']
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function transcribeXxxASR(config, audioBuffer): Promise<ASRTranscriptionResult>
 *    - Handle Buffer/Blob conversion (see helper patterns below)
 *    - Build API request with audio data (FormData or base64)
 *    - Handle API authentication (apiKey, headers)
 *    - Convert language codes if needed
 *    - Return { text: string }
 *
 *    Example:
 *    async function transcribeAssemblyAIASR(
 *      config: ASRModelConfig,
 *      audioBuffer: Buffer | Blob
 *    ): Promise<ASRTranscriptionResult> {
 *      const baseUrl = config.baseUrl || ASR_PROVIDERS['assemblyai-asr'].defaultBaseUrl;
 *
 *      // Step 1: Upload audio file
 *      let blob: Blob;
 *      if (audioBuffer instanceof Buffer) {
 *        blob = new Blob([audioBuffer.buffer.slice(
 *          audioBuffer.byteOffset,
 *          audioBuffer.byteOffset + audioBuffer.byteLength
 *        ) as ArrayBuffer], { type: 'audio/webm' });
 *      } else {
 *        blob = audioBuffer;
 *      }
 *
 *      const uploadResponse = await fetch(`${baseUrl}/upload`, {
 *        method: 'POST',
 *        headers: {
 *          'authorization': config.apiKey!,
 *        },
 *        body: blob,
```

### lib/audio/constants.ts
```
/**
 * Audio Provider Constants
 *
 * Registry of all TTS and ASR providers with their metadata.
 * Separated from tts-providers.ts and asr-providers.ts to avoid importing
 * Node.js libraries (like sharp, buffer) in client components.
 *
 * This file is client-safe and can be imported in both client and server components.
 *
 * To add a new provider:
 * 1. Add the provider ID to TTSProviderId or ASRProviderId in types.ts
 * 2. Add provider configuration to TTS_PROVIDERS or ASR_PROVIDERS below
 * 3. Implement provider logic in tts-providers.ts or asr-providers.ts
 * 4. Add i18n translations in lib/i18n.ts
 *
 * Provider configuration should include:
 * - id: Unique identifier matching the type definition
 * - name: Display name for the provider
 * - requiresApiKey: Whether the provider needs an API key
 * - defaultBaseUrl: Default API endpoint (optional)
 * - icon: Path to provider icon (optional)
 * - voices: Array of available voices (TTS only)
 * - supportedFormats: Audio formats supported by the provider
 * - speedRange: Min/max/default speed settings (TTS only)
 * - supportedLanguages: Languages supported by the provider (ASR only)
 */

import type {
  TTSProviderId,
  TTSProviderConfig,
  TTSVoiceInfo,
  ASRProviderId,
  ASRProviderConfig,
} from './types';

/**
 * TTS Provider Registry
 *
 * Central registry for all TTS providers.
 * Keep in sync with TTSProviderId type definition.
 */
export const TTS_PROVIDERS: Record<TTSProviderId, TTSProviderConfig> = {
  'openai-tts': {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    icon: '/logos/openai.svg',
    voices: [
      // Recommended voices (best quality)
      {
        id: 'marin',
        name: 'Marin',
        language: 'en',
        gender: 'neutral',
        description: 'voiceMarin',
      },
      {
        id: 'cedar',
        name: 'Cedar',
```

### lib/audio/types.ts
```
/**
 * Audio Provider Type Definitions
 *
 * Unified types for TTS (Text-to-Speech) and ASR (Automatic Speech Recognition)
 * with extensible architecture to support multiple providers.
 *
 * Currently Supported TTS Providers:
 * - OpenAI TTS (https://platform.openai.com/docs/guides/text-to-speech)
 * - Azure TTS (https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)
 * - GLM TTS (https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts)
 * - Qwen TTS (https://bailian.console.aliyun.com/)
 * - Browser Native TTS (Web Speech API, client-side only)
 *
 * Currently Supported ASR Providers:
 * - OpenAI Whisper (https://platform.openai.com/docs/guides/speech-to-text)
 * - Browser Native (Web Speech API, client-side only)
 * - Qwen ASR (DashScope API)
 *
 * Future Provider Support (extensible):
 * - ElevenLabs TTS/ASR (https://elevenlabs.io/docs)
 * - Fish Audio TTS (https://fish.audio/docs)
 * - Cartesia TTS (https://cartesia.ai/docs)
 * - PlayHT TTS (https://docs.play.ht/)
 * - AssemblyAI ASR (https://www.assemblyai.com/docs)
 * - Deepgram ASR (https://developers.deepgram.com/docs)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * Step 1: Add provider ID to the union type
 *   - For TTS: Add to TTSProviderId below
 *   - For ASR: Add to ASRProviderId below
 *
 * Step 2: Add provider configuration to constants.ts
 *   - Define provider metadata (name, icon, voices, formats, etc.)
 *   - Add to TTS_PROVIDERS or ASR_PROVIDERS registry
 *
 * Step 3: Implement provider logic in tts-providers.ts or asr-providers.ts
 *   - Add case to generateTTS() or transcribeAudio() switch statement
 *   - Implement API call logic for the new provider
 *
 * Step 4: Add i18n translations
 *   - Add provider name translations in lib/i18n.ts
 *   - Format: `provider{ProviderName}TTS` or `provider{ProviderName}ASR`
 *
 * Step 5 (Optional): Create client-side hook if needed
 *   - For browser-only providers, create hooks like use-browser-tts.ts
 *   - Export from lib/hooks/
 *
 * Example: Adding ElevenLabs TTS
 * ================================
 * 1. Add 'elevenlabs-tts' to TTSProviderId union type
 * 2. In constants.ts:
 *    TTS_PROVIDERS['elevenlabs-tts'] = {
 *      id: 'elevenlabs-tts',
 *      name: 'ElevenLabs',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.elevenlabs.io/v1',
 *      icon: '/elevenlabs.svg',
 *      voices: [...],
 *      supportedFormats: ['mp3', 'pcm'],
```

### lib/prosemirror/utils.ts
```
import type { Node, NodeType, ResolvedPos, Mark, MarkType, Schema } from 'prosemirror-model';
import type { EditorState, Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { selectAll } from 'prosemirror-commands';

export const isList = (node: Node, schema: Schema) => {
  return node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list;
};

export const autoSelectAll = (view: EditorView) => {
  const { empty } = view.state.selection;
  if (empty) selectAll(view.state, view.dispatch);
};

export const addMark = (
  editorView: EditorView,
  mark: Mark,
  selection?: { from: number; to: number },
) => {
  if (selection) {
    editorView.dispatch(editorView.state.tr.addMark(selection.from, selection.to, mark));
  } else {
    const { $from, $to } = editorView.state.selection;
    editorView.dispatch(editorView.state.tr.addMark($from.pos, $to.pos, mark));
  }
};

export const findNodesWithSameMark = (doc: Node, from: number, to: number, markType: MarkType) => {
  let ii = from;
  const finder = (mark: Mark) => mark.type === markType;
  let firstMark = null;
  let fromNode = null;
  let toNode = null;

  while (ii <= to) {
    const node = doc.nodeAt(ii);
    if (!node || !node.marks) return null;

    const mark = node.marks.find(finder);
    if (!mark) return null;

    if (firstMark && mark !== firstMark) return null;

    fromNode = fromNode || node;
    firstMark = firstMark || mark;
    toNode = node;
    ii++;
  }

  let fromPos = from;
  let toPos = to;

  let jj = 0;
  ii = from - 1;
  while (ii > jj) {
    const node = doc.nodeAt(ii);
    const mark = node && node.marks.find(finder);
    if (!mark || mark !== firstMark) break;
    fromPos = ii;
    fromNode = node;
```

### lib/prosemirror/index.ts
```
import { EditorState } from 'prosemirror-state';
import { type DirectEditorProps, EditorView } from 'prosemirror-view';
import { Schema, DOMParser } from 'prosemirror-model';
import { buildPlugins, type PluginOptions } from './plugins/index';
import { schemaNodes, schemaMarks } from './schema/index';

const schema = new Schema({
  nodes: schemaNodes,
  marks: schemaMarks,
});

export const createDocument = (content: string) => {
  const htmlString = `<div>${content}</div>`;
  const parser = new window.DOMParser();
  const element = parser.parseFromString(htmlString, 'text/html').body.firstElementChild;
  return DOMParser.fromSchema(schema).parse(element as Element);
};

export const initProsemirrorEditor = (
  dom: Element,
  content: string,
  props: Omit<DirectEditorProps, 'state'>,
  pluginOptions?: PluginOptions,
) => {
  return new EditorView(dom, {
    state: EditorState.create({
      doc: createDocument(content),
      plugins: buildPlugins(schema, pluginOptions),
    }),
    ...props,
  });
};
```

### lib/contexts/media-stage-context.tsx
```
'use client';

import { createContext, useContext } from 'react';

/**
 * Provides the current stageId to media-aware components (BaseImageElement, BaseVideoElement).
 *
 * When set, these components subscribe to the media generation store and only use
 * tasks whose stageId matches (preventing cross-course contamination).
 * When undefined (e.g. homepage thumbnails), store subscription is skipped entirely.
 */
const MediaStageContext = createContext<string | undefined>(undefined);

export const MediaStageProvider = MediaStageContext.Provider;

export function useMediaStageId(): string | undefined {
  return useContext(MediaStageContext);
}
```

### lib/contexts/scene-context.tsx
```
'use client';

import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useSyncExternalStore,
  useRef,
  useEffect,
} from 'react';
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';
import { produce } from 'immer';

interface SceneContextValue<T = unknown> {
  sceneId: string;
  sceneType: Scene['type'];
  sceneData: T;
  updateSceneData: (updater: (draft: T) => void) => void;
  // Internal: subscribe to scene data changes
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => T;
}

const SceneContext = createContext<SceneContextValue | null>(null);

/**
 * Generic Scene Provider
 * Provides current scene data and update methods to child components
 * Automatically syncs changes back to stageStore
 *
 * Usage:
 * <SceneProvider>
 *   <SlideRenderer /> // Uses useSceneData<SlideContent>()
 * </SceneProvider>
 */
export function SceneProvider({ children }: { children: React.ReactNode }) {
  // Subscribe to current scene
  const currentScene = useStageStore((state) => {
    if (!state.currentSceneId) return null;
    return state.scenes.find((s) => s.id === state.currentSceneId) || null;
  });

  const updateScene = useStageStore((state) => state.updateScene);

  const sceneId = currentScene?.id || '';
  const sceneType = currentScene?.type || 'slide';
  const sceneData = currentScene?.content || null;

  // Listeners for scene data changes
  const listenersRef = useRef(new Set<() => void>());

  // Subscribe function for child components
  const subscribe = useCallback((callback: () => void) => {
    listenersRef.current.add(callback);
    return () => {
      listenersRef.current.delete(callback);
    };
  }, []);
```

### lib/orchestration/tool-schemas.ts
```
/**
 * Action Schemas for Stateless Generation
 *
 * Text descriptions of actions for inclusion in structured output prompts.
 * Actions are parsed from JSON array items in the model's response.
 */

import { SLIDE_ONLY_ACTIONS } from '@/lib/types/action';

// ==================== Effective Actions ====================

/**
 * Filter allowed actions by scene type.
 * Slide-only actions (spotlight, laser) are removed for non-slide scenes.
 */
export function getEffectiveActions(allowedActions: string[], sceneType?: string): string[] {
  if (!sceneType || sceneType === 'slide') return allowedActions;
  return allowedActions.filter(
    (a) => !SLIDE_ONLY_ACTIONS.includes(a as (typeof SLIDE_ONLY_ACTIONS)[number]),
  );
}

// ==================== Text Descriptions ====================

/**
 * Get text descriptions of allowed actions for inclusion in system prompts.
 * Used when the model generates structured output with JSON array format.
 */
export function getActionDescriptions(allowedActions: string[]): string {
  const descriptions: Record<string, string> = {
    spotlight:
      'Focus attention on a single key element by dimming everything else. Use sparingly — max 1-2 per response. Parameters: { elementId: string, dimOpacity?: number }',
    laser:
      'Point at an element with a laser pointer effect. Parameters: { elementId: string, color?: string }',
    wb_open:
      'Open the whiteboard for hand-drawn explanations, formulas, diagrams, or step-by-step derivations. Creates a new whiteboard if none exists. Call this before adding elements. Parameters: {}',
    wb_draw_text:
      'Add text to the whiteboard. Use for writing formulas, steps, or key points. Parameters: { content: string, x: number, y: number, width?: number, height?: number, fontSize?: number, color?: string, elementId?: string }',
    wb_draw_shape:
      'Add a shape to the whiteboard. Use for diagrams and visual explanations. Parameters: { shape: "rectangle"|"circle"|"triangle", x: number, y: number, width: number, height: number, fillColor?: string, elementId?: string }',
    wb_draw_chart:
      'Add a chart to the whiteboard. Use for data visualization (bar charts, line graphs, pie charts, etc.). Parameters: { chartType: "bar"|"column"|"line"|"pie"|"ring"|"area"|"radar"|"scatter", x: number, y: number, width: number, height: number, data: { labels: string[], legends: string[], series: number[][] }, themeColors?: string[], elementId?: string }',
    wb_draw_latex:
      'Add a LaTeX formula to the whiteboard. Use for mathematical equations and scientific notation. Parameters: { latex: string, x: number, y: number, width?: number, height?: number, color?: string, elementId?: string }',
    wb_draw_table:
      'Add a table to the whiteboard. Use for structured data display and comparisons. Parameters: { x: number, y: number, width: number, height: number, data: string[][] (first row is header), outline?: { width: number, style: string, color: string }, theme?: { color: string }, elementId?: string }',
    wb_draw_line:
      'Add a line or arrow to the whiteboard. Use for connecting elements, drawing relationships, flow diagrams, or annotations. Parameters: { startX: number, startY: number, endX: number, endY: number, color?: string (default "#333333"), width?: number (line thickness, default 2), style?: "solid"|"dashed" (default "solid"), points?: [startMarker, endMarker] where marker is ""|"arrow" (default ["",""]), elementId?: string }',
    wb_clear:
      'Clear all elements from the whiteboard. Use when whiteboard is too crowded before adding new elements. Parameters: {}',
    wb_delete:
      'Delete a specific element from the whiteboard by its ID. Use to remove an outdated, incorrect, or overlapping element without clearing the entire board. Parameters: { elementId: string }',
    wb_close:
      'Close the whiteboard and return to the slide view. Always close after you finish drawing. Parameters: {}',
    play_video:
      'Start playback of a video element on the current slide. Synchronous — blocks until the video finishes playing. Use a speech action before this to introduce the video. Parameters: { elementId: string }',
  };

  if (allowedActions.length === 0) {
    return 'You have no actions available. You can only speak to students.';
```

### lib/orchestration/director-graph.ts
```
/**
 * Director Graph — LangGraph StateGraph for Multi-Agent Orchestration
 *
 * Unified graph topology (same for single and multi-agent):
 *
 *   START → director ──(end)──→ END
 *              │
 *              └─(next)→ agent_generate ──→ director (loop)
 *
 * The director node adapts its strategy based on agent count:
 *   - Single agent: pure code logic (no LLM). Dispatches the agent on
 *     turn 0, then cues the user on subsequent turns.
 *   - Multi agent: LLM-based decision (with code fast-paths for turn 0
 *     trigger agent and turn limits).
 *
 * Uses LangGraph's custom stream mode: each node pushes StatelessEvent
 * chunks via config.writer() for real-time SSE delivery.
 */

import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { LanguageModel } from 'ai';

import { AISdkLangGraphAdapter } from './ai-sdk-adapter';
import type { StatelessEvent } from '@/lib/types/chat';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  buildStructuredPrompt,
  summarizeConversation,
  convertMessagesToOpenAI,
} from './prompt-builder';
import { buildDirectorPrompt, parseDirectorDecision } from './director-prompt';
import { getEffectiveActions } from './tool-schemas';
import type { AgentTurnSummary, WhiteboardActionRecord } from './director-prompt';
import { parseStructuredChunk, createParserState, finalizeParser } from './stateless-generate';
import { createLogger } from '@/lib/logger';

const log = createLogger('DirectorGraph');

// ==================== State Definition ====================

/**
 * LangGraph state annotation for the orchestration graph
 */
const OrchestratorState = Annotation.Root({
  // Input (set once at graph entry)
  messages: Annotation<StatelessChatRequest['messages']>,
  storeState: Annotation<StatelessChatRequest['storeState']>,
  availableAgentIds: Annotation<string[]>,
  maxTurns: Annotation<number>,
  languageModel: Annotation<LanguageModel>,
  thinkingConfig: Annotation<ThinkingConfig | null>,
  discussionContext: Annotation<{ topic: string; prompt?: string } | null>,
  triggerAgentId: Annotation<string | null>,
  userProfile: Annotation<{ nickname?: string; bio?: string } | null>,
  /** Request-scoped agent configs for generated agents (not in the default registry) */
```

### lib/orchestration/prompt-builder.ts
```
/**
 * Prompt Builder for Stateless Generation
 *
 * Builds system prompts and converts messages for the LLM.
 */

import type { StatelessChatRequest } from '@/lib/types/chat';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { WhiteboardActionRecord, AgentTurnSummary } from './director-prompt';
import { getActionDescriptions, getEffectiveActions } from './tool-schemas';

// ==================== Role Guidelines ====================

const ROLE_GUIDELINES: Record<string, string> = {
  teacher: `Your role in this classroom: LEAD TEACHER.
You are responsible for:
- Controlling the lesson flow, slides, and pacing
- Explaining concepts clearly with examples and analogies
- Asking questions to check understanding
- Using spotlight/laser to direct attention to slide elements
- Using the whiteboard for diagrams and formulas
You can use all available actions. Never announce your actions — just teach naturally.`,

  assistant: `Your role in this classroom: TEACHING ASSISTANT.
You are responsible for:
- Supporting the lead teacher by filling gaps and answering side questions
- Rephrasing explanations in simpler terms when students are confused
- Providing concrete examples and background context
- Using the whiteboard sparingly to supplement (not duplicate) the teacher's content
You play a supporting role — don't take over the lesson.`,

  student: `Your role in this classroom: STUDENT.
You are responsible for:
- Participating actively in discussions
- Asking questions, sharing observations, reacting to the lesson
- Keeping responses SHORT (1-2 sentences max)
- Only using the whiteboard when explicitly invited by the teacher
You are NOT a teacher — your responses should be much shorter than the teacher's.`,
};

// ==================== Types ====================

/**
 * Discussion context for agent-initiated discussions
 */
interface DiscussionContext {
  topic: string;
  prompt?: string;
}

// ==================== Peer Context ====================

/**
 * Build a context section summarizing what other agents said this round.
 * Returns empty string if no agents have spoken yet.
 */
function buildPeerContextSection(
  agentResponses: AgentTurnSummary[] | undefined,
  currentAgentName: string,
): string {
```

### lib/orchestration/director-prompt.ts
```
/**
 * Director Prompt Builder
 *
 * Constructs the system prompt for the director agent that decides
 * which agent should respond next in a multi-agent conversation.
 */

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('DirectorPrompt');

/**
 * A single whiteboard action performed by an agent, recorded in the ledger.
 */
export interface WhiteboardActionRecord {
  actionName:
    | 'wb_draw_text'
    | 'wb_draw_shape'
    | 'wb_draw_chart'
    | 'wb_draw_latex'
    | 'wb_draw_table'
    | 'wb_draw_line'
    | 'wb_clear'
    | 'wb_delete'
    | 'wb_open'
    | 'wb_close';
  agentId: string;
  agentName: string;
  params: Record<string, unknown>;
}

/**
 * Summary of an agent's turn in the current round
 */
export interface AgentTurnSummary {
  agentId: string;
  agentName: string;
  contentPreview: string;
  actionCount: number;
  whiteboardActions: WhiteboardActionRecord[];
}

/**
 * Build the system prompt for the director agent
 *
 * @param agents - Available agent configurations
 * @param conversationSummary - Condensed summary of recent conversation
 * @param agentResponses - Agents that have already responded this round
 * @param turnCount - Current turn number in this round
 */
export function buildDirectorPrompt(
  agents: AgentConfig[],
  conversationSummary: string,
  agentResponses: AgentTurnSummary[],
  turnCount: number,
  discussionContext?: { topic: string; prompt?: string } | null,
  triggerAgentId?: string | null,
  whiteboardLedger?: WhiteboardActionRecord[],
  userProfile?: { nickname?: string; bio?: string },
```

### lib/orchestration/stateless-generate.ts
```
/**
 * Stateless Multi-Agent Generation
 *
 * Single-pass generation with structured JSON Array output format:
 * [{"type":"action","name":"...","params":{...}},{"type":"text","content":"natural speech"},...]
 *
 * Key design decisions:
 * - Backend is stateless (all state in request/response)
 * - Single generation pass (no generate/tool/loop)
 * - Text is natural teacher speech, NOT meta-commentary
 * - Tool calls are silent actions - students see results only
 * - Action and text objects can freely interleave in the array
 * - Uses partial-json for robust streaming of incomplete JSON
 *
 * Multi-agent orchestration:
 * - When multiple agents are configured, a director agent decides who speaks
 * - Uses LangGraph StateGraph for the orchestration loop
 * - Events are streamed via LangGraph's custom stream mode
 */

import type { LanguageModel } from 'ai';
import type { StatelessChatRequest, StatelessEvent, ParsedAction } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { WhiteboardActionRecord } from './director-prompt';
import { createOrchestrationGraph, buildInitialState } from './director-graph';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';

const log = createLogger('StatelessGenerate');

// ==================== Structured Output Parser ====================

/**
 * Parser state for incremental JSON Array parsing.
 *
 * Accumulates raw text from the LLM stream. Once the opening `[` is found,
 * uses `partial-json` to incrementally parse the growing array. Emits new
 * complete items as they appear, and streams partial text content deltas
 * for the last (potentially incomplete) text item.
 */
interface ParserState {
  /** Accumulated raw text from the LLM */
  buffer: string;
  /** Whether we've found the opening `[` */
  jsonStarted: boolean;
  /** Number of fully processed (emitted) items */
  lastParsedItemCount: number;
  /** Length of text content already emitted for the trailing partial text item */
  lastPartialTextLength: number;
  /** Whether parsing is complete (closing `]` found) */
  isDone: boolean;
}

/**
 * Create initial parser state
 */
export function createParserState(): ParserState {
  return {
    buffer: '',
```

### lib/orchestration/ai-sdk-adapter.ts
```
/**
 * AI SDK Adapter for LangGraph
 *
 * Provides LangChain-compatible interface for LLM calls.
 * Uses the unified callLLM / streamLLM layer which goes through
 * Vercel AI SDK, supporting all providers (OpenAI, Anthropic, Google, etc.).
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { ChatResult } from '@langchain/core/outputs';
import type { LanguageModel } from 'ai';

import { callLLM, streamLLM } from '@/lib/ai/llm';
import type { ThinkingConfig } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';

const log = createLogger('AISdkAdapter');

/**
 * Stream chunk types for streaming generation
 */
export type StreamChunk =
  | { type: 'delta'; content: string }
  | {
      type: 'tool_calls';
      toolCalls: {
        id: string;
        index: number;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { type: 'done'; content: string };

/**
 * Adapter to use any AI SDK LanguageModel with LangGraph
 *
 * Accepts a LanguageModel instance (from getModel()) instead of raw
 * API credentials, enabling support for all providers.
 */
export class AISdkLangGraphAdapter extends BaseChatModel {
  private languageModel: LanguageModel;
  private thinking?: ThinkingConfig;

  constructor(languageModel: LanguageModel, thinking?: ThinkingConfig) {
    super({});
    this.languageModel = languageModel;
    this.thinking = thinking;
  }

  _llmType(): string {
    return 'ai-sdk';
  }

  _combineLLMOutput() {
    return {};
  }

```

### lib/api/stage-api-types.ts
```
/**
 * Stage API - Type Definitions
 *
 * Shared types used across all stage-api sub-modules.
 */

import type { Stage, Scene, SceneContent, SceneType, StageMode } from '@/lib/types/stage';
import type { PPTElement } from '@/lib/types/slides';
import type { Action } from '@/lib/types/action';

// ==================== Type Definitions ====================

/**
 * API operation result
 */
export interface APIResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Scene creation parameters
 */
export interface CreateSceneParams {
  type: SceneType;
  title: string;
  content?: Partial<SceneContent>;
  order?: number;
  actions?: Action[];
}

/**
 * Element creation parameters (required fields)
 */
export type CreateElementParams = {
  type: PPTElement['type'];
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
  [key: string]: unknown; // Allow other element-specific properties
};

/**
 * Highlight options
 */
export interface HighlightOptions {
  duration?: number; // milliseconds
  color?: string;
  style?: 'outline' | 'fill' | 'shadow';
}

/**
 * Spotlight options
 */
export interface SpotlightOptions {
  duration?: number;
  radius?: number;
```

### lib/api/stage-api-navigation.ts
```
/**
 * Stage API - Navigation
 *
 * Factory function that creates the navigation namespace of the Stage API.
 * Handles scene navigation (goTo, next, previous, current).
 */

import type { Scene } from '@/lib/types/stage';
import type { StageStore, APIResult } from './stage-api-types';
import { validateSceneId, getScene } from './stage-api-defaults';

/**
 * Create the navigation API
 *
 * @param store - Zustand store instance
 * @returns Navigation namespace API
 */
export function createNavigationAPI(store: StageStore) {
  return {
    /**
     * Navigate to a specific scene
     *
     * @param sceneId - Scene ID
     * @returns Whether successful
     */
    goTo(sceneId: string): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!validateSceneId(state.scenes, sceneId)) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        store.setState({ currentSceneId: sceneId });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Next scene
     *
     * @returns Whether successful
     */
    next(): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!state.currentSceneId || state.scenes.length === 0) {
          return { success: false, error: 'No current scene' };
        }

        const currentIndex = state.scenes.findIndex((s) => s.id === state.currentSceneId);
        if (currentIndex === -1 || currentIndex === state.scenes.length - 1) {
          return { success: false, error: 'Already at last scene' };
        }

        const nextScene = state.scenes[currentIndex + 1];
```

### lib/api/stage-api-element.ts
```
/**
 * Stage API - Element Operations
 *
 * Factory function that creates the element namespace of the Stage API.
 * Handles element CRUD operations for slide-type scenes.
 */

import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement } from '@/lib/types/slides';
import type { StageStore, APIResult, CreateElementParams } from './stage-api-types';
import { generateId, getScene } from './stage-api-defaults';

/**
 * Create the element management API
 *
 * @param store - Zustand store instance
 * @returns Element namespace API
 */
export function createElementAPI(store: StageStore) {
  return {
    /**
     * Add an element to a Slide
     *
     * @param sceneId - Scene ID
     * @param element - Element parameters (must include type, left, top, width, height)
     * @returns Element ID
     */
    add(sceneId: string, element: CreateElementParams): APIResult<string> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;
        const elementId = generateId(element.type);

        const newElement: PPTElement = {
          ...element,
          id: elementId,
          rotate: element.rotate ?? 0,
        } as PPTElement;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  elements: [...content.canvas.elements, newElement],
                },
              },
```

### lib/api/stage-api-whiteboard.ts
```
/**
 * Stage API - Whiteboard Management
 *
 * Factory function that creates the whiteboard namespace of the Stage API.
 * Handles whiteboard CRUD and whiteboard element operations.
 */

import type { Whiteboard } from '@/lib/types/stage';
import type { PPTElement } from '@/lib/types/slides';
import type { StageStore, APIResult } from './stage-api-types';
import { generateId } from './stage-api-defaults';

/**
 * Create the whiteboard management API
 *
 * @param store - Zustand store instance
 * @returns Whiteboard namespace API
 */
export function createWhiteboardAPI(store: StageStore) {
  const whiteboardAPI = {
    /**
     * Create a whiteboard
     *
     * @returns Whether successful
     */
    create(): APIResult<Whiteboard> {
      try {
        const state = store.getState();
        const whiteboard: Whiteboard = {
          id: generateId('whiteboard'),
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          elements: [],
          background: {
            type: 'solid',
            color: '#ffffff',
          },
          animations: [],
        };
        const whiteboardList = state.stage?.whiteboard
          ? [...state.stage.whiteboard, whiteboard]
          : [whiteboard];
        store.setState({
          stage: { ...state.stage, whiteboard: whiteboardList },
        });
        return { success: true, data: whiteboard };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get a whiteboard
     *
     * @returns The most recently created whiteboard object
     */
    get(): APIResult<Whiteboard> {
      try {
        const state = store.getState();
        if (!state.stage?.whiteboard || state.stage.whiteboard.length === 0) {
```

### lib/api/stage-api-defaults.ts
```
/**
 * Stage API - Default Content & Utility Functions
 *
 * Shared utility functions for ID generation, scene validation,
 * and default content creation.
 */

import { nanoid } from 'nanoid';
import type {
  Scene,
  SceneType,
  SceneContent,
  SlideContent,
  QuizContent,
  InteractiveContent,
  PBLContent,
} from '@/lib/types/stage';

// ==================== Utility Functions ====================

/**
 * Generate a unique ID
 */
export function generateId(prefix?: string): string {
  return prefix ? `${prefix}_${nanoid(10)}` : nanoid(10);
}

/**
 * Validate whether a Scene ID exists
 */
export function validateSceneId(scenes: Scene[], sceneId: string): boolean {
  return scenes.some((s) => s.id === sceneId);
}

/**
 * Get a Scene
 */
export function getScene(scenes: Scene[], sceneId: string): Scene | null {
  return scenes.find((s) => s.id === sceneId) || null;
}

/**
 * Create default SlideContent
 */
export function createDefaultSlideContent(): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: generateId('slide'),
      viewportSize: 1000,
      viewportRatio: 0.5625, // 16:9
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
        outline: {
          color: '#d14424',
          width: 2,
          style: 'solid',
```

### lib/api/stage-api.ts
```
/**
 * Stage API - AI Agent Toolkit
 *
 * Provides a complete Stage operation interface for AI Agents to create and manage course content
 *
 * Design Principles:
 * 1. Type Safety: Fully leverage TypeScript's type system
 * 2. Ease of Use: Provide high-level abstractions with clear, intuitive API naming
 * 3. Extensibility: Support adding new scene types in the future
 * 4. Idempotency: Multiple calls with the same parameters produce the same result
 * 5. Error Handling: Return explicit success/failure status and error messages
 *
 * @example
 * ```typescript
 * const api = createStageAPI(stageStore);
 *
 * // Create a new scene
 * const sceneId = api.scene.create({
 *   type: 'slide',
 *   title: 'Introduction',
 *   // speech is now in actions
 * });
 *
 * // Add an element
 * const elementId = api.element.add(sceneId, {
 *   type: 'text',
 *   content: 'Hello World',
 *   left: 100,
 *   top: 100
 * });
 *
 * // Highlight an element (teaching feature)
 * api.canvas.highlight(sceneId, elementId, 3000);
 * ```
 */

// Re-export all types
export type {
  APIResult,
  CreateSceneParams,
  CreateElementParams,
  HighlightOptions,
  SpotlightOptions,
  StageStore,
} from './stage-api-types';

// Re-export utility functions that were previously accessible
export {
  generateId,
  validateSceneId,
  getScene,
  createDefaultContent,
  createDefaultSlideContent,
  createDefaultQuizContent,
  createDefaultInteractiveContent,
  createDefaultPBLContent,
} from './stage-api-defaults';

// Import sub-API factories
import { createSceneAPI } from './stage-api-scene';
```

### lib/api/stage-api-mode.ts
```
/**
 * Stage API - Mode & Stage Meta Management
 *
 * Factory functions that create the mode and stage namespaces of the Stage API.
 */

import type { Stage, StageMode } from '@/lib/types/stage';
import type { StageStore, APIResult } from './stage-api-types';

/**
 * Create the mode management API
 *
 * @param store - Zustand store instance
 * @returns Mode namespace API
 */
export function createModeAPI(store: StageStore) {
  return {
    /**
     * Set mode
     *
     * @param newMode - New mode
     */
    set(newMode: StageMode): APIResult<boolean> {
      try {
        store.setState({ mode: newMode });
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get current mode
     *
     * @returns Current mode
     */
    get(): APIResult<StageMode> {
      try {
        const state = store.getState();
        return { success: true, data: state.mode };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };
}

/**
 * Create the stage meta management API
 *
 * @param store - Zustand store instance
 * @returns Stage namespace API
 */
export function createStageMetaAPI(store: StageStore) {
  return {
    /**
     * Get Stage info
     *
     * @returns Stage object
     */
```

### lib/api/stage-api-scene.ts
```
/**
 * Stage API - Scene Management
 *
 * Factory function that creates the scene namespace of the Stage API.
 */

import type { Scene, SceneContent } from '@/lib/types/stage';
import type { StageStore, APIResult, CreateSceneParams } from './stage-api-types';
import { generateId, validateSceneId, getScene, createDefaultContent } from './stage-api-defaults';

/**
 * Create the scene management API
 *
 * @param store - Zustand store instance
 * @returns Scene namespace API
 */
export function createSceneAPI(store: StageStore) {
  return {
    /**
     * Create a new scene
     *
     * @param params - Scene parameters
     * @returns Scene ID
     *
     * @example
     * const sceneId = api.scene.create({
     *   type: 'slide',
     *   title: 'Introduction',
     *   // speech is now in actions
     * });
     */
    create(params: CreateSceneParams): APIResult<string> {
      try {
        const state = store.getState();

        if (!state.stage) {
          return {
            success: false,
            error: 'No stage set - cannot create scene without a stage',
          };
        }

        const sceneId = generateId('scene');

        // Determine order
        const order = params.order ?? state.scenes.length;

        // Create default content or use the provided content
        let content: SceneContent;
        if (params.content) {
          content = {
            ...createDefaultContent(params.type),
            ...params.content,
          } as SceneContent;
        } else {
          content = createDefaultContent(params.type);
        }

        const newScene: Scene = {
          id: sceneId,
```

### lib/api/stage-api-canvas.ts
```
/**
 * Stage API - Canvas Operations
 *
 * Factory function that creates the canvas namespace of the Stage API.
 * Handles background, theme, highlight, spotlight, laser, and zoom effects.
 * Uses useCanvasStore for visual overlay effects.
 */

import type { SlideContent } from '@/lib/types/stage';
import type { SlideTheme, SlideBackground } from '@/lib/types/slides';
import { useCanvasStore } from '@/lib/store/canvas';
import type { StageStore, APIResult, HighlightOptions, SpotlightOptions } from './stage-api-types';
import { getScene } from './stage-api-defaults';

/**
 * Create the canvas operations API
 *
 * @param store - Zustand store instance
 * @returns Canvas namespace API
 */
export function createCanvasAPI(store: StageStore) {
  return {
    /**
     * Set background
     *
     * @param sceneId - Scene ID
     * @param background - Background settings
     * @returns Whether successful
     */
    setBackground(sceneId: string, background: SlideBackground): APIResult<boolean> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene || scene.type !== 'slide') {
          return { success: false, error: 'Invalid scene' };
        }

        const content = scene.content as SlideContent;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  background,
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
```

### lib/pbl/mcp/issueboard-mcp.ts
```
/**
 * Issueboard MCP - Manages issues and workflow during PBL generation.
 *
 * Migrated from PBL-Nano. Key changes:
 * - No Anthropic SDK dependency (initialize_question_agent removed)
 * - Question agent initialization is handled by generate-pbl.ts post-processing
 * - Operates directly on a shared PBLProjectConfig
 */

import type { PBLProjectConfig, PBLIssue, PBLToolResult } from '../types';
import { AgentMCP } from './agent-mcp';
import { getQuestionAgentPrompt, getJudgeAgentPrompt } from './agent-templates';

export class IssueboardMCP {
  private config: PBLProjectConfig;
  private agentMCP: AgentMCP;
  private language: string;
  private nextIssueId: number;

  constructor(config: PBLProjectConfig, agentMCP: AgentMCP, language: string = 'en-US') {
    this.config = config;
    this.agentMCP = agentMCP;
    this.language = language;
    this.nextIssueId = 1;
  }

  createIssueboard(): PBLToolResult {
    this.config.issueboard = {
      agent_ids: [],
      issues: [],
      current_issue_id: null,
    };
    this.nextIssueId = 1;
    return { success: true, message: 'Issueboard created successfully.' };
  }

  getIssueboard(): PBLToolResult {
    return {
      success: true,
      agent_ids: [...this.config.issueboard.agent_ids],
      issues: this.config.issueboard.issues.map((i) => ({ ...i })),
    };
  }

  updateIssueboardAgents(agentIds: string[]): PBLToolResult {
    this.config.issueboard.agent_ids = [...agentIds];
    return {
      success: true,
      message: 'Issueboard agents updated successfully.',
    };
  }

  createIssue(params: {
    title: string;
    description: string;
    person_in_charge: string;
    participants?: string[];
    notes?: string;
    parent_issue?: string | null;
    index?: number;
```

### lib/pbl/mcp/agent-templates.ts
```
/**
 * Agent template prompts for PBL Question and Judge agents.
 *
 * Migrated from PBL-Nano with multi-language support.
 */

export function getQuestionAgentPrompt(language: string = 'en-US'): string {
  if (language === 'zh-CN') {
    return QUESTION_AGENT_TEMPLATE_PROMPT_ZH;
  }
  return QUESTION_AGENT_TEMPLATE_PROMPT;
}

export function getJudgeAgentPrompt(language: string = 'en-US'): string {
  if (language === 'zh-CN') {
    return JUDGE_AGENT_TEMPLATE_PROMPT_ZH;
  }
  return JUDGE_AGENT_TEMPLATE_PROMPT;
}

export const QUESTION_AGENT_TEMPLATE_PROMPT = `You are a Question Agent in a Project-Based Learning platform. Your role is to help students understand and complete their assigned issue.

## Your Responsibilities:

1. **Initial Question Generation**: When the issue is activated, you generate 1-3 specific, actionable questions based on the issue's title and description to guide students.

2. **Student Inquiries**: When students @mention you with questions:
   - Provide helpful hints and guidance
   - Ask clarifying questions to help them think critically
   - Never give direct answers - help them discover solutions
   - Reference the generated questions to keep them on track

## Guidelines:
- Be encouraging and supportive
- Focus on learning process, not just answers
- Help students break down complex problems
- Guide them to relevant resources or thinking approaches`;

export const JUDGE_AGENT_TEMPLATE_PROMPT = `You are a Judge Agent in a Project-Based Learning platform. Your role is to evaluate whether students have completed their assigned issue successfully.

## Your Responsibilities:

1. **Evaluate Completion**: When students @mention you:
   - Ask them to explain what they've accomplished
   - Review their work against the issue description and generated questions
   - Provide constructive feedback
   - Decide if the issue is complete or needs more work

2. **Feedback Format**:
   - Highlight what was done well
   - Point out gaps or areas for improvement
   - Give clear guidance on next steps if incomplete
   - Provide final verdict: "COMPLETE" or "NEEDS_REVISION"

## Guidelines:
- Be fair but encouraging
- Provide specific, actionable feedback
- Focus on learning outcomes, not perfection
- Celebrate successes while identifying growth areas`;

```

### lib/pbl/mcp/mode-mcp.ts
```
/**
 * Mode MCP - Controls the current workflow mode during PBL generation.
 *
 * Migrated from PBL-Nano. Simplified: no list_tools(), pure method calls.
 */

import type { PBLMode, PBLToolResult } from '../types';

export class ModeMCP {
  private currentMode: PBLMode;
  private availableModes: PBLMode[];

  constructor(availableModes: PBLMode[], defaultMode: PBLMode) {
    this.availableModes = availableModes;
    this.currentMode = defaultMode;
  }

  setMode(mode: PBLMode): PBLToolResult {
    if (!this.availableModes.includes(mode)) {
      return {
        success: false,
        error: `Mode "${mode}" not available. Available: ${this.availableModes.join(', ')}`,
      };
    }
    if (mode === this.currentMode) {
      return { success: false, error: `Already in "${mode}" mode.` };
    }
    this.currentMode = mode;
    return { success: true, message: `Switched to "${mode}" mode.` };
  }

  getCurrentMode(): PBLMode {
    return this.currentMode;
  }

  getAvailableModes(): PBLMode[] {
    return [...this.availableModes];
  }
}
```

### lib/pbl/mcp/agent-mcp.ts
```
/**
 * Agent MCP - Manages project agent roles during PBL generation.
 *
 * Migrated from PBL-Nano. No HTML rendering, no list_tools(), no hardcoded model.
 * Operates directly on a shared PBLProjectConfig.
 */

import type { PBLProjectConfig, PBLAgent, PBLRoleDivision, PBLToolResult } from '../types';

export class AgentMCP {
  private config: PBLProjectConfig;

  constructor(config: PBLProjectConfig) {
    this.config = config;
  }

  listAgents(): PBLToolResult {
    return {
      success: true,
      agents: this.config.agents.map((a) => ({ ...a })),
      message: this.config.agents.length === 0 ? 'No agents found.' : undefined,
    };
  }

  getAgentInfo(name: string): PBLToolResult {
    const agent = this.config.agents.find((a) => a.name === name);
    if (!agent) {
      return { success: false, error: `Agent "${name}" not found.` };
    }
    return { success: true, agent: { ...agent } };
  }

  createAgent(params: {
    name: string;
    system_prompt: string;
    default_mode: string;
    delay_time?: number;
    actor_role?: string;
    role_division?: PBLRoleDivision;
    is_system_agent?: boolean;
  }): PBLToolResult {
    const {
      name,
      system_prompt,
      default_mode,
      delay_time = 0,
      actor_role = '',
      role_division = 'development',
      is_system_agent = false,
    } = params;

    if (!name?.trim()) {
      return { success: false, error: 'Agent name cannot be empty.' };
    }
    if (!system_prompt?.trim()) {
      return { success: false, error: 'System prompt cannot be empty.' };
    }
    if (this.config.agents.find((a) => a.name === name)) {
      return { success: false, error: `Agent "${name}" already exists.` };
    }
```

### lib/pbl/mcp/project-mcp.ts
```
/**
 * Project MCP - Manages project info (title + description) during PBL generation.
 *
 * Migrated from PBL-Nano. No HTML rendering, no list_tools().
 * Operates directly on a shared PBLProjectConfig.
 */

import type { PBLProjectConfig, PBLToolResult } from '../types';

export class ProjectMCP {
  private config: PBLProjectConfig;

  constructor(config: PBLProjectConfig) {
    this.config = config;
  }

  getProjectInfo(): PBLToolResult {
    return {
      success: true,
      title: this.config.projectInfo.title,
      description: this.config.projectInfo.description,
    };
  }

  updateTitle(title: string): PBLToolResult {
    if (!title?.trim()) {
      return { success: false, error: 'Title cannot be empty.' };
    }
    this.config.projectInfo.title = title;
    return { success: true, message: 'Title updated successfully.' };
  }

  updateDescription(description: string): PBLToolResult {
    if (description === null || description === undefined) {
      return { success: false, error: 'Description cannot be null.' };
    }
    this.config.projectInfo.description = description;
    return { success: true, message: 'Description updated successfully.' };
  }
}
```

### lib/media/adapters/veo-adapter.ts
```
/**
 * Veo (Google) Video Generation Adapter
 *
 * Direct REST API calls for video generation with Google's Veo models.
 * Async task pattern: submit → poll → return inline base64 video.
 *
 * REST endpoints (Gemini API):
 * - Submit:   POST /v1beta/models/{model}:predictLongRunning
 * - Poll:     POST /v1beta/models/{model}:fetchPredictOperation  { operationName }
 *   Returns inline base64 video data in response.videos[]
 *
 * Supported models:
 * - veo-3.1-fast-generate-001  (fast, $0.15/sec)
 * - veo-3.1-generate-001       (quality, $0.40/sec)
 * - veo-3.0-fast-generate-001  (fast, $0.15/sec)
 * - veo-3.0-generate-001       (quality, $0.40/sec)
 * - veo-2.0-generate-001       (legacy, $0.50/sec)
 *
 * Authentication: x-goog-api-key header
 *
 * Stateless: video content is returned as a base64 data URL.
 * No files are saved on the server.
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'veo-3.0-generate-001';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_POLL_ATTEMPTS = 60; // 10 minutes max

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dimension defaults per aspect ratio */
function getDimensions(aspectRatio?: string): {
  width: number;
  height: number;
} {
  switch (aspectRatio) {
    case '9:16':
      return { width: 720, height: 1280 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:3':
      return { width: 1024, height: 768 };
    default:
      return { width: 1280, height: 720 }; // 16:9
  }
}

/** Common headers for all Veo API calls */
function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
```

### lib/media/adapters/kling-adapter.ts
```
/**
 * Kling (Kuaishou) Video Generation Adapter
 *
 * Async task pattern: submit → poll → return video URL.
 *
 * REST endpoints:
 * - Submit: POST /v1/videos/text2video
 * - Poll:   GET  /v1/videos/text2video/{task_id}
 *
 * Authentication: JWT Bearer token generated from Access Key + Secret Key.
 * The apiKey field should be formatted as "accessKey:secretKey".
 *
 * Supported models:
 * - kling-v2-6     (latest)
 * - kling-v1-6     (v1)
 *
 * API docs: https://docs.klingai.com/api
 */

import crypto from 'crypto';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'kling-v2-6';
const DEFAULT_BASE_URL = 'https://api-beijing.klingai.com';
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120; // 10 minutes max
const JWT_EXPIRY_SECS = 1800; // 30 minutes

// ---------------------------------------------------------------------------
// JWT helper (HS256, no external deps)
// ---------------------------------------------------------------------------

function base64url(data: Buffer | string): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generateJWT(accessKey: string, secretKey: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: accessKey,
      exp: now + JWT_EXPIRY_SECS,
      nbf: now - 5,
      iat: now,
    }),
  );

  const signature = base64url(
    crypto.createHmac('sha256', secretKey).update(`${header}.${payload}`).digest(),
  );

  return `${header}.${payload}.${signature}`;
}
```

### lib/media/adapters/seedream-adapter.ts
```
/**
 * Seedream (ByteDance / Doubao / Ark) Image Generation Adapter
 *
 * Uses OpenAI-compatible synchronous API format.
 * Endpoint: https://ark.cn-beijing.volces.com/api/v3/images/generations
 *
 * Supported models:
 * - doubao-seedream-5-0-260128  (latest / Lite, text2img + img2img + multi-ref + group)
 * - doubao-seedream-4-5-251128
 * - doubao-seedream-4-0-250828
 * - doubao-seedream-3-0-t2i-250415
 *
 * API docs: https://www.volcengine.com/docs/6791/1399028
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'doubao-seedream-5-0-260128';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com';

/**
 * Map our aspect ratio + size to Seedream size format "WxH".
 * Seedream requires minimum 3,686,400 pixels total.
 * Common sizes: 2048x2048 (2K), 2560x1440 (16:9), 1920x1920.
 */
function resolveSeedreamSize(options: ImageGenerationOptions): string {
  if (options.width && options.height) {
    // Ensure minimum pixel count (3,686,400)
    const pixels = options.width * options.height;
    if (pixels < 3_686_400) {
      // Scale up proportionally
      const scale = Math.ceil(Math.sqrt(3_686_400 / pixels));
      return `${options.width * scale}x${options.height * scale}`;
    }
    return `${options.width}x${options.height}`;
  }
  // Default to 2K for quality
  return '2K';
}

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request that triggers auth check. 401/403 means key invalid.
 */
export async function testSeedreamConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    // Send a request with empty prompt — auth failure (401/403) means bad key,
    // any other error (400) means key is valid but request is intentionally bad
    const response = await fetch(`${baseUrl}/api/v3/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
```

### lib/media/adapters/nano-banana-adapter.ts
```
/**
 * Nano Banana / Gemini Native Image Generation Adapter
 *
 * Uses Google Gemini's native image generation capability.
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Supported models:
 * - gemini-3.1-flash-image-preview  (Nano Banana 2 — latest, fastest)
 * - gemini-3-pro-image-preview      (Nano Banana Pro — highest quality)
 * - gemini-2.5-flash-image          (Nano Banana — original)
 *
 * Authentication: x-goog-api-key header
 *
 * API docs: https://ai.google.dev/gemini-api/docs/image-generation
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Lightweight connectivity test — validates API key by fetching model info.
 * Uses GET /v1beta/models/{model} which does not trigger generation.
 */
export async function testNanoBananaConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;
  const url = `${baseUrl}/v1beta/models`;

  // Try ?key= query param first (direct Google API), fall back to x-goog-api-key header (proxy)
  let response: Response | null = null;
  try {
```

### lib/media/adapters/qwen-image-adapter.ts
```
/**
 * Qwen Image (Alibaba Cloud / DashScope) Image Generation Adapter
 *
 * Uses DashScope multimodal generation API (synchronous, no polling needed).
 * Endpoint: https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *
 * Supported models:
 * - qwen-image-max     (highest quality)
 * - z-image-turbo      (fast, good quality)
 *
 * API docs: https://help.aliyun.com/zh/model-studio/developer-reference/text-to-image
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'qwen-image-max';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';

/**
 * Map our width x height to DashScope size format "WxH".
 * Common sizes: 1024*1024, 1280*720, 1664*928, 1120*1440, etc.
 */
function resolveDashScopeSize(options: ImageGenerationOptions): string {
  const w = options.width || 1024;
  const h = options.height || 576;
  return `${w}*${h}`;
}

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request. 401/403 means key invalid; other errors mean key is valid.
 */
export async function testQwenImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const response = await fetch(
      `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODEL,
          input: { messages: [{ role: 'user', content: [{ text: '' }] }] },
          parameters: { size: '1*1' },
        }),
      },
    );
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
```

### lib/media/adapters/seedance-adapter.ts
```
/**
 * Seedance (ByteDance / Doubao / Ark) Video Generation Adapter
 *
 * Uses async task pattern: submit task → poll until succeeded → get video URL.
 * Endpoint: https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
 *
 * Request format (text-to-video):
 *   POST /api/v3/contents/generations/tasks
 *   {
 *     "model": "doubao-seedance-1-5-pro-251215",
 *     "content": [{ "type": "text", "text": "prompt here" }],
 *     "ratio": "16:9",
 *     "duration": 5,
 *     "resolution": "1080p",
 *     "watermark": false
 *   }
 *
 * Supported models:
 * - doubao-seedance-1-5-pro-251215     (latest, 4~12s)
 * - doubao-seedance-1-0-pro-250528     (stable, 2~12s)
 * - doubao-seedance-1-0-pro-fast-251015 (faster, 2~12s)
 * - doubao-seedance-1-0-lite-t2v-250428 (lightweight, 2~12s)
 *
 * API docs: https://www.volcengine.com/docs/6492/2165104
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'doubao-seedance-1-5-pro-251215';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 60; // 5 minutes max

/** Response shape for task creation (only returns id) */
interface SeedanceSubmitResponse {
  id: string;
}

/** Response shape for task polling */
interface SeedancePollResponse {
  id: string;
  model: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  content?: {
    video_url?: string;
  };
  resolution?: string;
  ratio?: string;
  duration?: number;
  framespersecond?: number;
  error?: {
    message: string;
    code?: string;
  };
}

```

### lib/generation/prompts/index.ts
```
/**
 * Prompt System - Simplified prompt management
 *
 * Features:
 * - File-based prompt storage in templates/
 * - Snippet composition via {{snippet:name}} syntax
 * - Variable interpolation via {{variable}} syntax
 */

// Types
export type { PromptId, SnippetId, LoadedPrompt } from './types';

// Loader functions
export {
  loadPrompt,
  loadSnippet,
  buildPrompt,
  interpolateVariables,
  clearPromptCache,
} from './loader';

// Prompt IDs constant
export const PROMPT_IDS = {
  REQUIREMENTS_TO_OUTLINES: 'requirements-to-outlines',
  SLIDE_CONTENT: 'slide-content',
  QUIZ_CONTENT: 'quiz-content',
  SLIDE_ACTIONS: 'slide-actions',
  QUIZ_ACTIONS: 'quiz-actions',
  INTERACTIVE_SCIENTIFIC_MODEL: 'interactive-scientific-model',
  INTERACTIVE_HTML: 'interactive-html',
  INTERACTIVE_ACTIONS: 'interactive-actions',
  PBL_ACTIONS: 'pbl-actions',
} as const;
```

### lib/generation/prompts/loader.ts
```
/**
 * Prompt Loader - Loads prompts from markdown files
 *
 * Supports:
 * - Loading prompts from templates/{promptId}/ directory
 * - Snippet inclusion via {{snippet:name}} syntax
 * - Variable interpolation via {{variable}} syntax
 * - Caching for performance
 */

import fs from 'fs';
import path from 'path';
import type { PromptId, LoadedPrompt, SnippetId } from './types';
import { createLogger } from '@/lib/logger';
const log = createLogger('PromptLoader');

// Cache for loaded prompts and snippets
const promptCache = new Map<string, LoadedPrompt>();
const snippetCache = new Map<string, string>();

/**
 * Get the prompts directory path
 */
function getPromptsDir(): string {
  // In Next.js, use process.cwd() for the project root
  return path.join(process.cwd(), 'lib', 'generation', 'prompts');
}

/**
 * Load a snippet by ID
 */
export function loadSnippet(snippetId: SnippetId): string {
  const cached = snippetCache.get(snippetId);
  if (cached) return cached;

  const snippetPath = path.join(getPromptsDir(), 'snippets', `${snippetId}.md`);

  try {
    const content = fs.readFileSync(snippetPath, 'utf-8').trim();
    snippetCache.set(snippetId, content);
    return content;
  } catch {
    log.warn(`Snippet not found: ${snippetId}`);
    return `{{snippet:${snippetId}}}`;
  }
}

/**
 * Process snippet includes in a template
 * Replaces {{snippet:name}} with actual snippet content
 */
function processSnippets(template: string): string {
  return template.replace(/\{\{snippet:(\w[\w-]*)\}\}/g, (_, snippetId) => {
    return loadSnippet(snippetId as SnippetId);
  });
}

/**
 * Load a prompt by ID
 */
```

### lib/generation/prompts/types.ts
```
/**
 * Simplified prompt system type definitions
 */

/**
 * Prompt template identifier
 */
export type PromptId =
  | 'requirements-to-outlines'
  | 'slide-content'
  | 'quiz-content'
  | 'slide-actions'
  | 'quiz-actions'
  | 'interactive-scientific-model'
  | 'interactive-html'
  | 'interactive-actions'
  | 'pbl-actions';

/**
 * Snippet identifier
 */
export type SnippetId = 'json-output-rules' | 'element-types' | 'action-types';

/**
 * Loaded prompt template
 */
export interface LoadedPrompt {
  id: PromptId;
  systemPrompt: string;
  userPromptTemplate: string;
}
```

### lib/export/html-parser/parser.ts
```
import type {
  Token,
  HTMLNode,
  TagToken,
  NormalElement,
  TagEndToken,
  AttributeToken,
  TextToken,
} from './types';
import { closingTags, closingTagAncestorBreakers, voidTags } from './tags';

interface StackItem {
  tagName: string | null;
  children: HTMLNode[];
}

interface State {
  stack: StackItem[];
  cursor: number;
  tokens: Token[];
}

export const parser = (tokens: Token[]) => {
  const root: StackItem = { tagName: null, children: [] };
  const state: State = { tokens, cursor: 0, stack: [root] };
  parse(state);
  return root.children;
};

export const hasTerminalParent = (tagName: string, stack: StackItem[]) => {
  const tagParents = closingTagAncestorBreakers[tagName];
  if (tagParents) {
    let currentIndex = stack.length - 1;
    while (currentIndex >= 0) {
      const parentTagName = stack[currentIndex].tagName;
      if (parentTagName === tagName) break;
      if (parentTagName && tagParents.includes(parentTagName)) return true;
      currentIndex--;
    }
  }
  return false;
};

export const rewindStack = (stack: StackItem[], newLength: number) => {
  stack.splice(newLength);
};

export const parse = (state: State) => {
  const { stack, tokens } = state;
  let { cursor } = state;
  let nodes = stack[stack.length - 1].children;
  const len = tokens.length;

  while (cursor < len) {
    const token = tokens[cursor];
    if (token.type !== 'tag-start') {
      nodes.push(token as TextToken);
      cursor++;
      continue;
    }
```

### lib/export/html-parser/lexer.ts
```
import type { Token } from './types';
import { childlessTags } from './tags';

interface State {
  str: string;
  position: number;
  tokens: Token[];
}

const jumpPosition = (state: State, end: number) => {
  const len = end - state.position;
  movePositopn(state, len);
};

const movePositopn = (state: State, len: number) => {
  state.position = state.position + len;
};

const findTextEnd = (str: string, index: number) => {
  const isEnd = false;
  while (!isEnd) {
    const textEnd = str.indexOf('<', index);
    if (textEnd === -1) {
      return textEnd;
    }
    const char = str.charAt(textEnd + 1);
    if (char === '/' || char === '!' || /[A-Za-z0-9]/.test(char)) {
      return textEnd;
    }
    index = textEnd + 1;
  }
  return -1;
};

const lexText = (state: State) => {
  const { str } = state;
  let textEnd = findTextEnd(str, state.position);
  if (textEnd === state.position) return;
  if (textEnd === -1) {
    textEnd = str.length;
  }

  const content = str.slice(state.position, textEnd);
  jumpPosition(state, textEnd);

  state.tokens.push({
    type: 'text',
    content,
  });
};

const lexComment = (state: State) => {
  const { str } = state;

  movePositopn(state, 4);
  let contentEnd = str.indexOf('-->', state.position);
  let commentEnd = contentEnd + 3;
  if (contentEnd === -1) {
    contentEnd = commentEnd = str.length;
  }
```

### lib/export/html-parser/index.ts
```
// Reference: https://github.com/andrejewski/himalaya — rewritten in TypeScript with simplified functionality

import { lexer } from './lexer';
import { parser } from './parser';
import { format } from './format';
import { toHTML } from './stringify';
export type { AST } from './types';

export const toAST = (str: string) => {
  const tokens = lexer(str);
  const nodes = parser(tokens);
  return format(nodes);
};

export { toHTML };
```

### lib/export/html-parser/stringify.ts
```
import type { AST, ElementAST, ElementAttribute } from './types';
import { voidTags } from './tags';

export const formatAttributes = (attributes: ElementAttribute[]) => {
  return attributes.reduce((attrs, attribute) => {
    const { key, value } = attribute;
    if (value === null) return `${attrs} ${key}`;
    if (key === 'style' && !value) return '';

    const quoteEscape = value.indexOf("'") !== -1;
    const quote = quoteEscape ? '"' : "'";
    return `${attrs} ${key}=${quote}${value}${quote}`;
  }, '');
};

export const toHTML = (tree: AST[]) => {
  const htmlStrings: string[] = tree.map((node) => {
    if (node.type === 'text') return node.content;
    if (node.type === 'comment') return `<!--${node.content}-->`;

    const { tagName, attributes, children } = node as ElementAST;
    const isSelfClosing = voidTags.includes(tagName.toLowerCase());

    if (isSelfClosing) return `<${tagName}${formatAttributes(attributes)}>`;
    return `<${tagName}${formatAttributes(attributes)}>${toHTML(children)}</${tagName}>`;
  });
  return htmlStrings.join('');
};
```

### lib/export/html-parser/types.ts
```
export interface ElementAttribute {
  key: string;
  value: string | null;
}

export interface CommentElement {
  type: 'comment';
  content: string;
}

export interface TextElement {
  type: 'text';
  content: string;
}

export interface NormalElement {
  type: 'element';
  tagName: string;
  children: HTMLNode[];
  attributes: string[];
}

export type HTMLNode = CommentElement | TextElement | NormalElement;

export interface ElementAST {
  type: 'element';
  tagName: string;
  children: AST[];
  attributes: ElementAttribute[];
}

export interface CommentOrTextAST {
  type: 'comment' | 'text';
  content: string;
}

export type AST = CommentOrTextAST | ElementAST;

export interface TagStartToken {
  type: 'tag-start';
  close: boolean;
}

export interface TagEndToken {
  type: 'tag-end';
  close: boolean;
}

export interface TagToken {
  type: 'tag';
  content: string;
}

export interface TextToken {
  type: 'text';
  content: string;
}

export interface CommentToken {
  type: 'comment';
```

### lib/export/html-parser/tags.ts
```
export const childlessTags = ['style', 'script', 'template'];

export const closingTags = [
  'html',
  'head',
  'body',
  'p',
  'dt',
  'dd',
  'li',
  'option',
  'thead',
  'th',
  'tbody',
  'tr',
  'td',
  'tfoot',
  'colgroup',
];

export const closingTagAncestorBreakers: Record<string, string[]> = {
  li: ['ul', 'ol', 'menu'],
  dt: ['dl'],
  dd: ['dl'],
  tbody: ['table'],
  thead: ['table'],
  tfoot: ['table'],
  tr: ['table'],
  td: ['table'],
};

export const voidTags = [
  '!doctype',
  'area',
  'base',
  'br',
  'col',
  'command',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
];
```

### lib/export/html-parser/format.ts
```
import type { HTMLNode, CommentOrTextAST, ElementAST, AST } from './types';

export const splitHead = (str: string, sep: string) => {
  const idx = str.indexOf(sep);
  if (idx === -1) return [str];
  return [str.slice(0, idx), str.slice(idx + sep.length)];
};

const unquote = (str: string) => {
  const car = str.charAt(0);
  const end = str.length - 1;
  const isQuoteStart = car === '"' || car === "'";
  if (isQuoteStart && car === str.charAt(end)) {
    return str.slice(1, end);
  }
  return str;
};

const formatAttributes = (attributes: string[]) => {
  return attributes.map((attribute) => {
    const parts = splitHead(attribute.trim(), '=');
    const key = parts[0];
    const value = typeof parts[1] === 'string' ? unquote(parts[1]) : null;
    return { key, value };
  });
};

export const format = (nodes: HTMLNode[]): AST[] => {
  return nodes.map((node) => {
    if (node.type === 'element') {
      const children = format(node.children);
      const item: ElementAST = {
        type: 'element',
        tagName: node.tagName.toLowerCase(),
        attributes: formatAttributes(node.attributes),
        children,
      };
      return item;
    }

    const item: CommentOrTextAST = {
      type: node.type,
      content: node.content,
    };
    return item;
  });
};
```

### lib/storage/providers/noop.ts
```
import type { StorageProvider, StorageType } from '../types';

/** No-op provider used when no external storage is configured. */
export class NoopStorageProvider implements StorageProvider {
  async upload(): Promise<string> {
    return '';
  }
  async exists(): Promise<boolean> {
    return false;
  }
  getUrl(): string {
    return '';
  }
  async batchExists(_hashes: string[], _type: StorageType): Promise<Set<string>> {
    return new Set();
  }
}
```

### lib/prosemirror/commands/setTextIndent.ts
```
import type { Schema } from 'prosemirror-model';
import { type Transaction, TextSelection, AllSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { isList } from '../utils';

type IndentKey = 'indent' | 'textIndent';

function setNodeIndentMarkup(
  tr: Transaction,
  pos: number,
  delta: number,
  indentKey: IndentKey,
): Transaction {
  if (!tr.doc) return tr;

  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;

  const minIndent = 0;
  const maxIndent = 8;

  let indent = (node.attrs[indentKey] || 0) + delta;
  if (indent < minIndent) indent = minIndent;
  if (indent > maxIndent) indent = maxIndent;

  if (indent === node.attrs[indentKey]) return tr;

  const nodeAttrs = {
    ...node.attrs,
    [indentKey]: indent,
  };

  return tr.setNodeMarkup(pos, node.type, nodeAttrs, node.marks);
}

const setIndent = (
  tr: Transaction,
  schema: Schema,
  delta: number,
  indentKey: IndentKey,
): Transaction => {
  const { selection, doc } = tr;
  if (!selection || !doc) return tr;

  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return tr;

  const { from, to } = selection;

  doc.nodesBetween(from, to, (node, pos) => {
    const nodeType = node.type;

    if (nodeType.name === 'paragraph' || nodeType.name === 'blockquote') {
      tr = setNodeIndentMarkup(tr, pos, delta, indentKey);
      return false;
    } else if (isList(node, schema)) return false;
    return true;
  });

  return tr;
};
```

### lib/prosemirror/commands/setTextAlign.ts
```
import type { Schema, Node, NodeType } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

export const setTextAlign = (tr: Transaction, schema: Schema, alignment: string) => {
  const { selection, doc } = tr;
  if (!selection || !doc) return tr;

  const { from, to } = selection;
  const { nodes } = schema;

  const blockquote = nodes.blockquote;
  const listItem = nodes.list_item;
  const paragraph = nodes.paragraph;

  interface Task {
    node: Node;
    pos: number;
    nodeType: NodeType;
  }

  const tasks: Task[] = [];
  alignment = alignment || '';

  const allowedNodeTypes = new Set([blockquote, listItem, paragraph]);

  doc.nodesBetween(from, to, (node, pos) => {
    const nodeType = node.type;
    const align = node.attrs.align || '';
    if (align !== alignment && allowedNodeTypes.has(nodeType)) {
      tasks.push({
        node,
        pos,
        nodeType,
      });
    }
    return true;
  });

  if (!tasks.length) return tr;

  tasks.forEach((task) => {
    const { node, pos, nodeType } = task;
    let { attrs } = node;
    if (alignment) attrs = { ...attrs, align: alignment };
    else attrs = { ...attrs, align: null };
    tr = tr.setNodeMarkup(pos, nodeType, attrs, node.marks);
  });

  return tr;
};

export const alignmentCommand = (view: EditorView, alignment: string) => {
  const { state } = view;
  const { schema, selection } = state;
  const tr = setTextAlign(state.tr.setSelection(selection), schema, alignment);
  view.dispatch(tr);
};
```

### lib/prosemirror/commands/setListStyle.ts
```
import type { EditorView } from 'prosemirror-view';
import { isList } from '../utils';

type Style = Record<string, string>;

export const setListStyle = (view: EditorView, style: Style | Style[]) => {
  const { state } = view;
  const { schema, selection } = state;
  const tr = state.tr.setSelection(selection);

  const { doc } = tr;
  if (!doc) return tr;

  const { from, to } = selection;
  doc.nodesBetween(from, to, (node, pos) => {
    if (isList(node, schema)) {
      if (from - 3 <= pos && to + 3 >= pos + node.nodeSize) {
        const styles = Array.isArray(style) ? style : [style];

        for (const style of styles) {
          tr.setNodeAttribute(pos, style.key, style.value);
        }
      }
    }
    return false;
  });

  view.dispatch(tr);
};
```

### lib/prosemirror/commands/toggleList.ts
```
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import type { Node, NodeType } from 'prosemirror-model';
import type { Transaction, EditorState } from 'prosemirror-state';
import { findParentNode, isList } from '../utils';

type Attr = Record<string, number | string>;

interface TextStyleAttr {
  color?: string;
  fontsize?: string;
}

export const toggleList = (
  listType: NodeType,
  itemType: NodeType,
  listStyleType: string,
  textStyleAttr: TextStyleAttr = {},
) => {
  return (state: EditorState, dispatch: (tr: Transaction) => void) => {
    const { schema, selection } = state;
    const { $from, $to } = selection;
    const range = $from.blockRange($to);

    if (!range) return false;

    const parentList = findParentNode((node: Node) => isList(node, schema))(selection);

    if (range.depth >= 1 && parentList && range.depth - parentList.depth <= 1) {
      if (parentList.node.type === listType && !listStyleType) {
        return liftListItem(itemType)(state, dispatch);
      }

      if (isList(parentList.node, schema) && listType.validContent(parentList.node.content)) {
        const { tr } = state;

        const nodeAttrs: Attr = {
          ...parentList.node.attrs,
          ...textStyleAttr,
        };
        if (listStyleType) nodeAttrs.listStyleType = listStyleType;

        tr.setNodeMarkup(parentList.pos, listType, nodeAttrs);

        if (dispatch) dispatch(tr);

        return false;
      }
    }

    const nodeAttrs: Attr = {
      ...textStyleAttr,
    };
    if (listStyleType) nodeAttrs.listStyleType = listStyleType;

    return wrapInList(listType, nodeAttrs)(state, dispatch);
  };
};
```

### lib/prosemirror/commands/replaceText.ts
```
import { EditorView } from 'prosemirror-view';
import { Mark, NodeType, Node } from 'prosemirror-model';

export const replaceText = (view: EditorView, newText: string) => {
  const { state } = view;
  const { schema, doc } = state;

  let marks: Mark[] = [];
  let nodeType: NodeType = schema.nodes.paragraph;

  if (doc.content.size > 2) {
    const firstCharPos = doc.resolve(1);

    marks = [...firstCharPos.marks()];

    nodeType = firstCharPos.parent.type;
  }

  const lines = newText.split('\n');

  const newNodes: Node[] = lines.map((line: string) => {
    if (line.trim() === '') return nodeType.create();

    const textNode = schema.text(line, marks);
    return nodeType.create(null, textNode);
  });

  const tr = state.tr;

  tr.replaceWith(0, doc.content.size, newNodes);

  view.dispatch(tr);
};
```

### lib/prosemirror/schema/marks.ts
```
import { marks } from 'prosemirror-schema-basic';
import type { MarkSpec } from 'prosemirror-model';

const subscript: MarkSpec = {
  excludes: 'subscript',
  parseDOM: [
    { tag: 'sub' },
    {
      style: 'vertical-align',
      getAttrs: (value) => value === 'sub' && null,
    },
  ],
  toDOM: () => ['sub', 0],
};

const superscript: MarkSpec = {
  excludes: 'superscript',
  parseDOM: [
    { tag: 'sup' },
    {
      style: 'vertical-align',
      getAttrs: (value) => value === 'super' && null,
    },
  ],
  toDOM: () => ['sup', 0],
};

const strikethrough: MarkSpec = {
  parseDOM: [
    { tag: 'strike' },
    {
      style: 'text-decoration',
      getAttrs: (value) => value === 'line-through' && null,
    },
    {
      style: 'text-decoration-line',
      getAttrs: (value) => value === 'line-through' && null,
    },
  ],
  toDOM: () => ['span', { style: 'text-decoration-line: line-through;' }, 0],
};

const underline: MarkSpec = {
  parseDOM: [
    { tag: 'u' },
    {
      style: 'text-decoration',
      getAttrs: (value) => value === 'underline' && null,
    },
    {
      style: 'text-decoration-line',
      getAttrs: (value) => value === 'underline' && null,
    },
  ],
  toDOM: () => ['span', { style: 'text-decoration: underline;' }, 0],
};

const forecolor: MarkSpec = {
  attrs: {
    color: {},
```

### lib/prosemirror/schema/index.ts
```
import nodes from './nodes';
import marks from './marks';

export const schemaNodes = nodes;
export const schemaMarks = marks;
```

### lib/prosemirror/schema/nodes.ts
```
import { nodes } from 'prosemirror-schema-basic';
import type { Node, NodeSpec } from 'prosemirror-model';
import { listItem as _listItem } from 'prosemirror-schema-list';

type Attr = Record<string, number | string>;

const orderedList: NodeSpec = {
  attrs: {
    order: {
      default: 1,
    },
    listStyleType: {
      default: '',
    },
    fontsize: {
      default: '',
    },
    color: {
      default: '',
    },
  },
  content: 'list_item+',
  group: 'block',
  parseDOM: [
    {
      tag: 'ol',
      getAttrs: (dom) => {
        const order =
          ((dom as HTMLElement).hasAttribute('start')
            ? (dom as HTMLElement).getAttribute('start')
            : 1) || 1;
        const attr: Attr = { order: +order };

        const { listStyleType, fontSize, color } = (dom as HTMLElement).style;
        if (listStyleType) attr['listStyleType'] = listStyleType;
        if (fontSize) attr['fontsize'] = fontSize;
        if (color) attr['color'] = color;

        return attr;
      },
    },
  ],
  toDOM: (node: Node) => {
    const { order, listStyleType, fontsize, color } = node.attrs;
    let style = '';
    if (listStyleType) style += `list-style-type: ${listStyleType};`;
    if (fontsize) style += `font-size: ${fontsize};`;
    if (color) style += `color: ${color};`;

    const attr: Attr = { style };
    if (order !== 1) attr['start'] = order;

    return ['ol', attr, 0];
  },
};

const bulletList: NodeSpec = {
  attrs: {
    listStyleType: {
      default: '',
```

### lib/prosemirror/plugins/inputrules.ts
```
import type { NodeType, Schema } from 'prosemirror-model';
import {
  inputRules,
  wrappingInputRule,
  smartQuotes,
  emDash,
  ellipsis,
  InputRule,
} from 'prosemirror-inputrules';

const blockQuoteRule = (nodeType: NodeType) => wrappingInputRule(/^\s*>\s$/, nodeType);

const orderedListRule = (nodeType: NodeType) =>
  wrappingInputRule(
    /^(\d+)\.\s$/,
    nodeType,
    (match) => ({ order: +match[1] }),
    (match, node) => node.childCount + node.attrs.order === +match[1],
  );

const bulletListRule = (nodeType: NodeType) => wrappingInputRule(/^\s*([-+*])\s$/, nodeType);

const codeRule = () => {
  const inputRegex = /(?:^|\s)((?:`)((?:[^`]+))(?:`))$/;

  return new InputRule(inputRegex, (state, match, start, end) => {
    const { schema } = state;

    const tr = state.tr.insertText(`${match[2]} `, start, end);
    const mark = schema.marks.code.create();

    return tr.addMark(start, start + match[2].length, mark);
  });
};

const linkRule = () => {
  const urlRegEx = /(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\.?(?:\d+)?(?:\/\S*)?$/;

  return new InputRule(urlRegEx, (state, match, start, end) => {
    const { schema } = state;

    const tr = state.tr.insertText(match[0], start, end);
    const mark = schema.marks.link.create({ href: match[0], title: match[0] });

    return tr.addMark(start, start + match[0].length, mark);
  });
};

export const buildInputRules = (schema: Schema) => {
  const rules = [...smartQuotes, ellipsis, emDash];
  rules.push(blockQuoteRule(schema.nodes.blockquote));
  rules.push(orderedListRule(schema.nodes.ordered_list));
  rules.push(bulletListRule(schema.nodes.bullet_list));
  rules.push(codeRule());
  rules.push(linkRule());

  return inputRules({ rules });
};
```

### lib/prosemirror/plugins/placeholder.ts
```
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';

const isEmptyParagraph = (node: Node) => {
  return node.type.name === 'paragraph' && node.nodeSize === 2;
};

export const placeholderPlugin = (placeholder: string) => {
  return new Plugin({
    props: {
      decorations(state) {
        const { $from } = state.selection;
        if (isEmptyParagraph($from.parent)) {
          const decoration = Decoration.node($from.before(), $from.after(), {
            'data-placeholder': placeholder,
          });
          return DecorationSet.create(state.doc, [decoration]);
        }
      },
    },
  });
};
```

### lib/prosemirror/plugins/index.ts
```
import { keymap } from 'prosemirror-keymap';
import type { Schema } from 'prosemirror-model';
import { history } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';

import { buildKeymap } from './keymap';
import { buildInputRules } from './inputrules';
import { placeholderPlugin } from './placeholder';

export interface PluginOptions {
  placeholder?: string;
}

export const buildPlugins = (schema: Schema, options?: PluginOptions) => {
  const placeholder = options?.placeholder;

  const plugins = [
    buildInputRules(schema),
    keymap(buildKeymap(schema)),
    keymap(baseKeymap),
    dropCursor(),
    gapCursor(),
    history(),
  ];

  if (placeholder) plugins.push(placeholderPlugin(placeholder));

  return plugins;
};
```

### lib/prosemirror/plugins/keymap.ts
```
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import type { Schema } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import type { Command } from 'prosemirror-state';
import {
  toggleMark,
  selectParentNode,
  joinUp,
  joinDown,
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlockKeepMarks,
} from 'prosemirror-commands';

export const buildKeymap = (schema: Schema) => {
  const keys: Record<string, Command> = {};
  const bind = (key: string, cmd: Command) => (keys[key] = cmd);

  bind('Alt-ArrowUp', joinUp);
  bind('Alt-ArrowDown', joinDown);
  bind('Mod-z', undo);
  bind('Mod-y', redo);
  bind('Backspace', undoInputRule);
  bind('Escape', selectParentNode);
  bind('Mod-b', toggleMark(schema.marks.strong));
  bind('Mod-i', toggleMark(schema.marks.em));
  bind('Mod-u', toggleMark(schema.marks.underline));
  bind('Mod-d', toggleMark(schema.marks.strikethrough));
  bind('Mod-e', toggleMark(schema.marks.code));
  bind('Mod-;', toggleMark(schema.marks.superscript));
  bind(`Mod-'`, toggleMark(schema.marks.subscript));
  bind(
    'Enter',
    chainCommands(
      splitListItem(schema.nodes.list_item),
      newlineInCode,
      createParagraphNear,
      liftEmptyBlock,
      splitBlockKeepMarks,
    ),
  );
  bind('Mod-[', liftListItem(schema.nodes.list_item));
  bind('Mod-]', sinkListItem(schema.nodes.list_item));
  bind('Tab', sinkListItem(schema.nodes.list_item));

  return keys;
};
```

### lib/orchestration/registry/store.ts
```
/**
 * Agent Registry Store
 * Manages configurable AI agents using Zustand with localStorage persistence
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentConfig } from './types';
import { getActionsForRole } from './types';
import { USER_AVATAR } from '@/lib/types/roundtable';
import type { Participant, ParticipantRole } from '@/lib/types/roundtable';
import { useUserProfileStore } from '@/lib/store/user-profile';

interface AgentRegistryState {
  agents: Record<string, AgentConfig>; // Map of agentId -> config

  // Actions
  addAgent: (agent: AgentConfig) => void;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void;
  deleteAgent: (id: string) => void;
  getAgent: (id: string) => AgentConfig | undefined;
  listAgents: () => AgentConfig[];
}

// Action types available to agents
const WHITEBOARD_ACTIONS = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_clear',
  'wb_delete',
];

const SLIDE_ACTIONS = ['spotlight', 'laser', 'play_video'];

// Default agents - always available on both server and client
const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  'default-1': {
    id: 'default-1',
    name: 'AI teacher',
    role: 'teacher',
    persona: `You are the lead teacher of this classroom. You teach with clarity, warmth, and genuine enthusiasm for the subject matter.

Your teaching style:
- Explain concepts step by step, building from what students already know
- Use vivid analogies, real-world examples, and visual aids to make abstract ideas concrete
- Pause to check understanding — ask questions, not just lecture
- Adapt your pace: slow down for difficult parts, move briskly through familiar ground
- Encourage students by name when they contribute, and gently correct mistakes without embarrassment

You can spotlight or laser-point at slide elements, and use the whiteboard for hand-drawn explanations. Use these actions naturally as part of your teaching flow. Never announce your actions; just teach.

Tone: Professional yet approachable. Patient. Encouraging. You genuinely care about whether students understand.`,
    avatar: '/avatars/teacher.png',
    color: '#3b82f6',
```

### lib/orchestration/registry/types.ts
```
/**
 * Agent Configuration Types
 * Defines the structure for configurable AI agents in the multi-agent system
 */

export interface AgentConfig {
  id: string; // Unique agent ID
  name: string; // Display name (Chinese)
  role: string; // Short role description
  persona: string; // Full system prompt (personality, responsibilities)
  avatar: string; // Emoji or image URL
  color: string; // UI theme color (hex)
  allowedActions: string[]; // Action types this agent can use
  priority: number; // Priority for director selection (1-10)

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  isDefault: boolean; // Is this a default template?

  // LLM-generated agent fields
  isGenerated?: boolean; // true for LLM-generated agents
  boundStageId?: string; // stage ID this agent was generated for
}

export interface AgentTemplate {
  // Same as AgentConfig but without id/dates (for creating new agents)
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  allowedActions: string[];
  priority: number;

  // LLM-generated agent fields
  isGenerated?: boolean; // true for LLM-generated agents
  boundStageId?: string; // stage ID this agent was generated for
}

/**
 * Create a new AgentConfig from a template
 */
export function createAgentFromTemplate(template: AgentTemplate, id: string): AgentConfig {
  return {
    id,
    ...template,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: false,
  };
}

// Action types available to agents (canonical source for role-based mapping)
export const WHITEBOARD_ACTIONS = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
```

### packages/mathml2omml/rollup.config.js
```
import { nodeResolve } from '@rollup/plugin-node-resolve'

const onwarn = (warning) => {
  // Silence circular dependency warning for moment package
  if (warning.code === 'CIRCULAR_DEPENDENCY') {
    return
  }

  console.warn(`(!) ${warning.message}`)
}

export default {
  input: 'src/index.js',
  output: [
    {
      file: 'dist/index.js',
      format: 'module',
      sourcemap: true
    },
    {
      file: 'dist/index.cjs',
      format: 'commonjs',
      sourcemap: true
    }
  ],
  plugins: [nodeResolve()],
  onwarn
}
```

### packages/pptxgenjs/types/index.d.ts
```
// Type definitions for pptxgenjs 4.0.1
// Project: https://gitbrent.github.io/PptxGenJS/
// Definitions by: Brent Ely <https://github.com/gitbrent/>
//                 Michael Beaumont <https://github.com/michaelbeaumont>
//                 Nicholas Tietz-Sokolsky <https://github.com/ntietz>
//                 David Adams <https://github.com/iota-pi>
//                 Stephen Cronin <https://github.com/cronin4392>
// TypeScript Version: 3.x

export as namespace PptxGenJS

export default PptxGenJS

declare class PptxGenJS {
	/**
	 * PptxGenJS Library Version
	 * @type {string}
	 */
	readonly version: string

	// Exposed prop types
	readonly presLayout: PptxGenJS.PresLayout
	readonly AlignH: typeof PptxGenJS.AlignH
	readonly AlignV: typeof PptxGenJS.AlignV
	readonly ChartType: typeof PptxGenJS.ChartType
	readonly OutputType: typeof PptxGenJS.OutputType
	readonly SchemeColor: typeof PptxGenJS.SchemeColor
	readonly ShapeType: typeof PptxGenJS.ShapeType
	readonly PlaceholderType: typeof PptxGenJS.PLACEHOLDER_TYPES

	// Presentation Props

	/**
	 * Presentation layout name.
	 * Standard layouts:
	 * - 'LAYOUT_4x3'   (10" x 7.5")
	 * - 'LAYOUT_16x9'  (10" x 5.625")
	 * - 'LAYOUT_16x10' (10" x 6.25")
	 * - 'LAYOUT_WIDE'  (13.33" x 7.5")
	 *
	 * Custom layouts:
	 * - Use `pptx.defineLayout()` to create custom layouts (e.g.: 'A4')
	 *
	 * @type {string}
	 * @see https://support.office.com/en-us/article/Change-the-size-of-your-slides-040a811c-be43-40b9-8d04-0de5ed79987e
	 */
	layout: string
	/**
	 * Whether Right-to-Left (RTL) mode is enabled
	 * @type {boolean}
	 */
	rtlMode: boolean

	// Presentation Metadata
	/**
	 * Author name
	 * @type {string}
	 */
	author: string
	/**
```

### packages/pptxgenjs/src/gen-media.ts
```
/**
 * PptxGenJS: Media Methods
 */

import { IMG_BROKEN } from './core-enums'
import { PresSlide, SlideLayout, ISlideRelMedia } from './core-interfaces'

/**
 * Encode Image/Audio/Video into base64
 * @param {PresSlide | SlideLayout} layout - slide layout
 * @return {Promise} promise
 */
export function encodeSlideMediaRels(layout: PresSlide | SlideLayout): Array<Promise<string>> {
	// STEP 1: Detect real Node runtime once
	const isNode = typeof process !== 'undefined' && !!process.versions?.node && process.release?.name === 'node'
	// These will be filled only when we’re in Node
	let fs: typeof import('node:fs') | undefined
	let https: typeof import('node:https') | undefined

	// STEP 2: Lazy-load Node built-ins if needed
	const loadNodeDeps = isNode
		? async () => {
			; ({ default: fs } = await import('node:fs')); ({ default: https } = await import('node:https'))
		}
		: async () => { }
	// Immediately start it when we know we’re in Node
	if (isNode) loadNodeDeps()

	// STEP 3: Prepare promises list
	const imageProms: Array<Promise<string>> = []

	// A: Capture all audio/image/video candidates for encoding (filtering online/pre-encoded)
	const candidateRels = layout._relsMedia.filter(
		rel => rel.type !== 'online' && !rel.data && (!rel.path || (rel.path && !rel.path.includes('preencoded')))
	)

	// B: PERF: Mark dupes (same `path`) to avoid loading the same media over-and-over!
	const unqPaths: string[] = []
	candidateRels.forEach(rel => {
		if (!unqPaths.includes(rel.path)) {
			rel.isDuplicate = false
			unqPaths.push(rel.path)
		} else {
			rel.isDuplicate = true
		}
	})

	// STEP 4: Read/Encode each unique media item
	candidateRels
		.filter(rel => !rel.isDuplicate)
		.forEach(rel => {
			imageProms.push(
				(async () => {
					if (!https) await loadNodeDeps()

					// ────────────  NODE LOCAL FILE  ────────────
					if (isNode && fs && rel.path.indexOf('http') !== 0) {
						try {
							const bitmap = fs.readFileSync(rel.path)
							rel.data = Buffer.from(bitmap).toString('base64')
```

### packages/pptxgenjs/src/gen-tables.ts
```
/**
 * PptxGenJS: Table Generation
 */

import { DEF_FONT_SIZE, DEF_SLIDE_MARGIN_IN, EMU, LINEH_MODIFIER, ONEPT, SLIDE_OBJECT_TYPES } from './core-enums'
import { PresLayout, SlideLayout, TableCell, TableToSlidesProps, TableRow, TableRowSlide, TableCellProps } from './core-interfaces'
import { getSmartParseNumber, inch2Emu, rgbToHex, valToPts } from './gen-utils'
import PptxGenJS from './pptxgen'

/**
 * Break cell text into lines based upon table column width (e.g.: Magic Happens Here(tm))
 * @param {TableCell} cell - table cell
 * @param {number} colWidth - table column width (inches)
 * @return {TableRow[]} - cell's text objects grouped into lines
 */
function parseTextToLines(cell: TableCell, colWidth: number, verbose?: boolean): TableCell[][] {
	// FYI: CPL = Width / (font-size / font-constant)
	// FYI: CHAR:2.3, colWidth:10, fontSize:12 => CPL=138, (actual chars per line in PPT)=145 [14.5 CPI]
	// FYI: CHAR:2.3, colWidth:7 , fontSize:12 => CPL= 97, (actual chars per line in PPT)=100 [14.3 CPI]
	// FYI: CHAR:2.3, colWidth:9 , fontSize:16 => CPL= 96, (actual chars per line in PPT)=84  [ 9.3 CPI]
	const FOCO = 2.3 + (cell.options?.autoPageCharWeight ? cell.options.autoPageCharWeight : 0) // Character Constant
	const CPL = Math.floor((colWidth / ONEPT) * EMU) / ((cell.options?.fontSize ? cell.options.fontSize : DEF_FONT_SIZE) / FOCO) // Chars-Per-Line

	const parsedLines: TableCell[][] = []
	let inputCells: TableCell[] = []
	const inputLines1: TableCell[][] = []
	const inputLines2: TableCell[][] = []
	/*
		if (cell.options && cell.options.autoPageCharWeight) {
			let CHR1 = 2.3 + (cell.options && cell.options.autoPageCharWeight ? cell.options.autoPageCharWeight : 0) // Character Constant
			let CPL1 = ((colWidth / ONEPT) * EMU) / ((cell.options && cell.options.fontSize ? cell.options.fontSize : DEF_FONT_SIZE) / CHR1) // Chars-Per-Line
			console.log(`cell.options.autoPageCharWeight: '${cell.options.autoPageCharWeight}' => CPL: ${CPL1}`)
			let CHR2 = 2.3 + 0
			let CPL2 = ((colWidth / ONEPT) * EMU) / ((cell.options && cell.options.fontSize ? cell.options.fontSize : DEF_FONT_SIZE) / CHR2) // Chars-Per-Line
			console.log(`cell.options.autoPageCharWeight: '0' => CPL: ${CPL2}`)
		}
	*/

	/**
	 * EX INPUTS: `cell.text`
	 * - string....: "Account Name Column"
	 * - object....: { text:"Account Name Column" }
	 * - object[]..: [{ text:"Account Name", options:{ bold:true } }, { text:" Column" }]
	 * - object[]..: [{ text:"Account Name", options:{ breakLine:true } }, { text:"Input" }]
	 */

	/**
	 * EX OUTPUTS:
	 * - string....: [{ text:"Account Name Column" }]
	 * - object....: [{ text:"Account Name Column" }]
	 * - object[]..: [{ text:"Account Name", options:{ breakLine:true } }, { text:"Input" }]
	 * - object[]..: [{ text:"Account Name", options:{ breakLine:true } }, { text:"Input" }]
	 */

	// STEP 1: Ensure inputCells is an array of TableCells
	if (cell.text && cell.text.toString().trim().length === 0) {
		// Allow a single space/whitespace as cell text (user-requested feature)
		inputCells.push({ _type: SLIDE_OBJECT_TYPES.tablecell, text: ' ' })
	} else if (typeof cell.text === 'number' || typeof cell.text === 'string') {
		inputCells.push({ _type: SLIDE_OBJECT_TYPES.tablecell, text: (cell.text || '').toString().trim() })
```

### packages/pptxgenjs/src/pptxgen.ts
```
/**
 *  :: pptxgen.ts ::
 *
 *  JavaScript framework that creates PowerPoint (pptx) presentations
 *  https://github.com/gitbrent/PptxGenJS
 *
 *  This framework is released under the MIT Public License (MIT)
 *
 *  PptxGenJS (C) 2015-present Brent Ely -- https://github.com/gitbrent
 *
 *  Some code derived from the OfficeGen project:
 *  github.com/Ziv-Barber/officegen/ (Copyright 2013 Ziv Barber)
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *
 *  The above copyright notice and this permission notice shall be included in all
 *  copies or substantial portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * Units of Measure used in PowerPoint documents
 *
 * PowerPoint units are in `DXA` (except for font sizing)
 * - 1 inch is 1440 DXA
 * - 1 inch is 72 points
 * -  1 DXA is 1/20th's of a point
 * - 20 DXA is 1 point
 *
 * Another form of measurement using is an `EMU`
 * - 914400 EMUs is 1 inch
 * -  12700 EMUs is 1 point
 *
 * @see https://startbigthinksmall.wordpress.com/2010/01/04/points-inches-and-emus-measuring-units-in-office-open-xml/
 */

/**
 * Object Layouts
 *
 * - 16x9 (10" x 5.625")
 * - 16x10 (10" x 6.25")
 * - 4x3 (10" x 7.5")
 * - Wide (13.33" x 7.5")
 * - [custom] (any size)
 *
 * @see https://docs.microsoft.com/en-us/office/open-xml/structure-of-a-presentationml-document
 * @see https://docs.microsoft.com/en-us/previous-versions/office/developer/office-2010/hh273476(v=office.14)
 */
```

### packages/pptxgenjs/src/core-enums.ts
```
/**
 * PptxGenJS Enums
 * NOTE: `enum` wont work for objects, so use `Object.freeze`
 */

import { BorderProps, OptsChartGridLine } from './core-interfaces'

// CONST
export const EMU = 914400 // One (1) inch (OfficeXML measures in EMU (English Metric Units))
export const ONEPT = 12700 // One (1) point (pt)
export const CRLF = '\r\n' // AKA: Chr(13) & Chr(10)
export const LAYOUT_IDX_SERIES_BASE = 2147483649
export const REGEX_HEX_COLOR = /^[0-9a-fA-F]{6}$/
export const LINEH_MODIFIER = 1.67 // AKA: Golden Ratio Typography

export const DEF_BULLET_MARGIN = 27
export const DEF_CELL_BORDER: BorderProps = { type: 'solid', color: '666666', pt: 1 }
export const DEF_CELL_MARGIN_PT: [number, number, number, number] = [3, 3, 3, 3] // TRBL-style // DEPRECATED 3.8.0
export const DEF_CELL_MARGIN_IN: [number, number, number, number] = [0.05, 0.1, 0.05, 0.1] // "Normal" margins in PPT-2021 ("Narrow" is `0.05` for all 4)
export const DEF_CHART_BORDER: BorderProps = { type: 'solid', color: '363636', pt: 1 }
export const DEF_CHART_GRIDLINE: OptsChartGridLine = { color: '888888', style: 'solid', size: 1, cap: 'flat' }
export const DEF_FONT_COLOR = '000000'
export const DEF_FONT_SIZE = 12
export const DEF_FONT_TITLE_SIZE = 18
export const DEF_PRES_LAYOUT = 'LAYOUT_16x9'
export const DEF_PRES_LAYOUT_NAME = 'DEFAULT'
export const DEF_SHAPE_LINE_COLOR = '333333'
export const DEF_SHAPE_SHADOW = { type: 'outer', blur: 3, offset: 23000 / 12700, angle: 90, color: '000000', opacity: 0.35, rotateWithShape: true }
export const DEF_SLIDE_BKGD = 'FFFFFF'
export const DEF_SLIDE_MARGIN_IN: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5] // TRBL-style
export const DEF_TEXT_SHADOW = { type: 'outer', blur: 8, offset: 4, angle: 270, color: '000000', opacity: 0.75 }
export const DEF_TEXT_GLOW = { size: 8, color: 'FFFFFF', opacity: 0.75 }

export const AXIS_ID_VALUE_PRIMARY = '2094734552'
export const AXIS_ID_VALUE_SECONDARY = '2094734553'
export const AXIS_ID_CATEGORY_PRIMARY = '2094734554'
export const AXIS_ID_CATEGORY_SECONDARY = '2094734555'
export const AXIS_ID_SERIES_PRIMARY = '2094734556'

export type JSZIP_OUTPUT_TYPE = 'arraybuffer' | 'base64' | 'binarystring' | 'blob' | 'nodebuffer' | 'uint8array'
export type WRITE_OUTPUT_TYPE = JSZIP_OUTPUT_TYPE | 'STREAM'
export type CHART_NAME = 'area' | 'bar' | 'bar3D' | 'bubble' | 'bubble3D' | 'doughnut' | 'line' | 'pie' | 'radar' | 'scatter'
export type SCHEME_COLORS = 'tx1' | 'tx2' | 'bg1' | 'bg2' | 'accent1' | 'accent2' | 'accent3' | 'accent4' | 'accent5' | 'accent6'

export const LETTERS: string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
export const BARCHART_COLORS: string[] = [
	'C0504D',
	'4F81BD',
	'9BBB59',
	'8064A2',
	'4BACC6',
	'F79646',
	'628FC6',
	'C86360',
	'C0504D',
	'4F81BD',
	'9BBB59',
	'8064A2',
	'4BACC6',
	'F79646',
```

### packages/pptxgenjs/src/gen-objects.ts
```
/**
 * PptxGenJS: Slide Object Generators
 */

import {
	BARCHART_COLORS,
	CHART_NAME,
	CHART_TYPE,
	DEF_CELL_BORDER,
	DEF_CELL_MARGIN_IN,
	DEF_CHART_BORDER,
	DEF_FONT_COLOR,
	DEF_FONT_SIZE,
	DEF_SHAPE_LINE_COLOR,
	DEF_SLIDE_MARGIN_IN,
	EMU,
	IMG_PLAYBTN,
	MASTER_OBJECTS,
	PIECHART_COLORS,
	SCHEME_COLOR_NAMES,
	SHAPE_NAME,
	SHAPE_TYPE,
	SLIDE_OBJECT_TYPES,
	TEXT_HALIGN,
	TEXT_VALIGN,
} from './core-enums'
import {
	AddSlideProps,
	BackgroundProps,
	FormulaProps,
	IChartMulti,
	IChartOptsLib,
	IOptsChartData,
	ISlideObject,
	ImageProps,
	MediaProps,
	ObjectOptions,
	OptsChartGridLine,
	PresLayout,
	PresSlide,
	ShapeLineProps,
	ShapeProps,
	SlideLayout,
	SlideMasterProps,
	TableCell,
	TableProps,
	TableRow,
	TextProps,
	TextPropsOptions,
} from './core-interfaces'
import { getSlidesForTableRows } from './gen-tables'
import { encodeXmlEntities, getNewRelId, getSmartParseNumber, inch2Emu, valToPts, correctShadowOptions } from './gen-utils'

/** counter for included charts (used for index in their filenames) */
let _chartCounter = 0

/**
 * Transforms a slide definition to a slide object that is then passed to the XML transformation process.
 * @param {SlideMasterProps} props - slide definition
 * @param {PresSlide|SlideLayout} target - empty slide object that should be updated by the passed definition
```

### packages/pptxgenjs/src/gen-utils.ts
```
/**
 * PptxGenJS: Utility Methods
 */

import { EMU, REGEX_HEX_COLOR, DEF_FONT_COLOR, ONEPT, SchemeColor, SCHEME_COLORS } from './core-enums'
import { PresLayout, TextGlowProps, PresSlide, ShapeFillProps, Color, ShapeLineProps, Coord, ShadowProps } from './core-interfaces'

/**
 * Translates any type of `x`/`y`/`w`/`h` prop to EMU
 * - guaranteed to return a result regardless of undefined, null, etc. (0)
 * - {number} - 12800 (EMU)
 * - {number} - 0.5 (inches)
 * - {string} - "75%"
 * @param {number|string} size - numeric ("5.5") or percentage ("90%")
 * @param {'X' | 'Y'} xyDir - direction
 * @param {PresLayout} layout - presentation layout
 * @returns {number} calculated size
 */
export function getSmartParseNumber (size: Coord, xyDir: 'X' | 'Y', layout: PresLayout): number {
	// FIRST: Convert string numeric value if reqd
	if (typeof size === 'string' && !isNaN(Number(size))) size = Number(size)

	// CASE 1: Number in inches
	// Assume any number less than 100 is inches
	if (typeof size === 'number' && size < 100) return inch2Emu(size)

	// CASE 2: Number is already converted to something other than inches
	// Assume any number greater than 100 sure isnt inches! Just return it (assume value is EMU already).
	if (typeof size === 'number' && size >= 100) return size

	// CASE 3: Percentage (ex: '50%')
	if (typeof size === 'string' && size.includes('%')) {
		if (xyDir && xyDir === 'X') return Math.round((parseFloat(size) / 100) * layout.width)
		if (xyDir && xyDir === 'Y') return Math.round((parseFloat(size) / 100) * layout.height)

		// Default: Assume width (x/cx)
		return Math.round((parseFloat(size) / 100) * layout.width)
	}

	// LAST: Default value
	return 0
}

/**
 * Basic UUID Generator Adapted
 * @link https://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript#answer-2117523
 * @param {string} uuidFormat - UUID format
 * @returns {string} UUID
 */
export function getUuid (uuidFormat: string): string {
	return uuidFormat.replace(/[xy]/g, function (c) {
		const r = (Math.random() * 16) | 0
		const v = c === 'x' ? r : (r & 0x3) | 0x8
		return v.toString(16)
	})
}

/**
 * Replace special XML characters with HTML-encoded strings
 * @param {string} xml - XML string to encode
```

### packages/pptxgenjs/src/gen-charts.ts
```
/**
 * PptxGenJS: Chart Generation
 */

import {
	AXIS_ID_CATEGORY_PRIMARY,
	AXIS_ID_CATEGORY_SECONDARY,
	AXIS_ID_SERIES_PRIMARY,
	AXIS_ID_VALUE_PRIMARY,
	AXIS_ID_VALUE_SECONDARY,
	BARCHART_COLORS,
	CHART_NAME,
	CHART_TYPE,
	DEF_CHART_GRIDLINE,
	DEF_FONT_COLOR,
	DEF_FONT_SIZE,
	DEF_FONT_TITLE_SIZE,
	DEF_SHAPE_SHADOW,
	LETTERS,
	ONEPT,
} from './core-enums'
import { IChartOptsLib, ISlideRelChart, ShadowProps, IChartPropsTitle, OptsChartGridLine, IOptsChartData, ChartLineCap } from './core-interfaces'
import { createColorElement, genXmlColorSelection, convertRotationDegrees, encodeXmlEntities, getUuid, valToPts } from './gen-utils'
import JSZip from 'jszip'

/**
 * Based on passed data, creates Excel Worksheet that is used as a data source for a chart.
 * @param {ISlideRelChart} chartObject - chart object
 * @param {JSZip} zip - file that the resulting XLSX should be added to
 * @return {Promise} promise of generating the XLSX file
 */
export async function createExcelWorksheet (chartObject: ISlideRelChart, zip: JSZip): Promise<string> {
	const data = chartObject.data

	return await new Promise((resolve, reject) => {
		const zipExcel = new JSZip()
		const intBubbleCols = (data.length - 1) * 2 + 1 // 1 for "X-Values", then 2 for every Y-Axis
		const IS_MULTI_CAT_AXES = data[0]?.labels?.length > 1

		// A: Add folders
		zipExcel.folder('_rels')
		zipExcel.folder('docProps')
		zipExcel.folder('xl/_rels')
		zipExcel.folder('xl/tables')
		zipExcel.folder('xl/theme')
		zipExcel.folder('xl/worksheets')
		zipExcel.folder('xl/worksheets/_rels')

		// B: Add core contents
		{
			zipExcel.file(
				'[Content_Types].xml',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'  <Default Extension="xml" ContentType="application/xml"/>' +
				'  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				'  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
				'  <Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
				'  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
				'  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
```

### packages/pptxgenjs/src/gen-xml.ts
```
/**
 * PptxGenJS: XML Generation
 */

import {
	BULLET_TYPES,
	CRLF,
	DEF_BULLET_MARGIN,
	DEF_CELL_MARGIN_IN,
	DEF_PRES_LAYOUT_NAME,
	DEF_TEXT_GLOW,
	DEF_TEXT_SHADOW,
	EMU,
	LAYOUT_IDX_SERIES_BASE,
	PLACEHOLDER_TYPES,
	SLDNUMFLDID,
	SLIDE_OBJECT_TYPES,
} from './core-enums'
import {
	IPresentationProps,
	ISlideObject,
	ISlideRel,
	ISlideRelChart,
	ISlideRelMedia,
	ObjectOptions,
	PresSlide,
	ShadowProps,
	SlideLayout,
	TableCell,
	TableCellProps,
	TextProps,
	TextPropsOptions,
} from './core-interfaces'
import {
	convertRotationDegrees,
	createColorElement,
	createGlowElement,
	encodeXmlEntities,
	genXmlColorSelection,
	getSmartParseNumber,
	getUuid,
	inch2Emu,
	valToPts,
} from './gen-utils'

const ImageSizingXml = {
	cover: function (imgSize: { w: number, h: number }, boxDim: { w: number, h: number, x: number, y: number }) {
		const imgRatio = imgSize.h / imgSize.w
		const boxRatio = boxDim.h / boxDim.w
		const isBoxBased = boxRatio > imgRatio
		const width = isBoxBased ? boxDim.h / imgRatio : boxDim.w
		const height = isBoxBased ? boxDim.h : boxDim.w * imgRatio
		const hzPerc = Math.round(1e5 * 0.5 * (1 - boxDim.w / width))
		const vzPerc = Math.round(1e5 * 0.5 * (1 - boxDim.h / height))
		return `<a:srcRect l="${hzPerc}" r="${hzPerc}" t="${vzPerc}" b="${vzPerc}"/><a:stretch/>`
	},
	contain: function (imgSize: { w: number, h: number }, boxDim: { w: number, h: number, x: number, y: number }) {
		const imgRatio = imgSize.h / imgSize.w
		const boxRatio = boxDim.h / boxDim.w
		const widthBased = boxRatio > imgRatio
```

### packages/pptxgenjs/src/slide.ts
```
/**
 * PptxGenJS: Slide Class
 */

import { CHART_NAME, SHAPE_NAME } from './core-enums'
import {
	AddSlideProps,
	BackgroundProps,
	FormulaProps,
	HexColor,
	IChartMulti,
	IChartOpts,
	IChartOptsLib,
	IOptsChartData,
	ISlideObject,
	ISlideRel,
	ISlideRelChart,
	ISlideRelMedia,
	ImageProps,
	MediaProps,
	PresLayout,
	PresSlide,
	ShapeProps,
	SlideLayout,
	SlideNumberProps,
	TableProps,
	TableRow,
	TextProps,
	TextPropsOptions,
} from './core-interfaces'
import * as genObj from './gen-objects'

export default class Slide {
	private readonly _setSlideNum: (value: SlideNumberProps) => void

	public addSlide: (options?: AddSlideProps) => PresSlide
	public getSlide: (slideNum: number) => PresSlide
	public _name: string
	public _presLayout: PresLayout
	public _rels: ISlideRel[]
	public _relsChart: ISlideRelChart[]
	public _relsMedia: ISlideRelMedia[]
	public _rId: number
	public _slideId: number
	public _slideLayout: SlideLayout
	public _slideNum: number
	public _slideNumberProps: SlideNumberProps
	public _slideObjects: ISlideObject[]
	public _newAutoPagedSlides: PresSlide[]

	constructor(params: {
		addSlide: (options?: AddSlideProps) => PresSlide
		getSlide: (slideNum: number) => PresSlide
		presLayout: PresLayout
		setSlideNum: (value: SlideNumberProps) => void
		slideId: number
		slideRId: number
		slideNumber: number
		slideLayout?: SlideLayout
	}) {
```

### packages/pptxgenjs/src/core-interfaces.ts
```
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PptxGenJS Interfaces
 */

import { CHART_NAME, PLACEHOLDER_TYPE, SHAPE_NAME, SLIDE_OBJECT_TYPES, TEXT_HALIGN, TEXT_VALIGN, WRITE_OUTPUT_TYPE } from './core-enums'

// Core Types
// ==========

/**
 * Coordinate number - either:
 * - Inches (0-n)
 * - Percentage (0-100)
 *
 * @example 10.25 // coordinate in inches
 * @example '75%' // coordinate as percentage of slide size
 */
export type Coord = number | `${number}%`
export interface PositionProps {
	/**
	 * Horizontal position
	 * - inches or percentage
	 * @example 10.25 // position in inches
	 * @example '75%' // position as percentage of slide size
	 */
	x?: Coord
	/**
	 * Vertical position
	 * - inches or percentage
	 * @example 10.25 // position in inches
	 * @example '75%' // position as percentage of slide size
	 */
	y?: Coord
	/**
	 * Height
	 * - inches or percentage
	 * @example 10.25 // height in inches
	 * @example '75%' // height as percentage of slide size
	 */
	h?: Coord
	/**
	 * Width
	 * - inches or percentage
	 * @example 10.25 // width in inches
	 * @example '75%' // width as percentage of slide size
	 */
	w?: Coord
}
/**
 * Either `data` or `path` is required
 */
export interface DataOrPathProps {
	/**
	 * URL or relative path
	 *
	 * @example 'https://onedrives.com/myimg.png` // retrieve image via URL
	 * @example '/home/gitbrent/images/myimg.png` // retrieve image via local path
	 */
	path?: string
```

### packages/mathml2omml/src/index.d.ts
```
export interface MML2OMMLOptions {
  /**
   * Whether to disable XML decoding of input
   */
  disableDecode?: boolean
}

/**
 * Convert MathML to Office Open XML Math (OMML) format
 *
 * @param mmlString - MathML string to convert
 * @param options - Optional configuration options
 * @returns OMML string
 */
export function mml2omml(mmlString: string, options?: MML2OMMLOptions): string

/**
 * MML2OMML class for converting MathML to OMML
 */
export class MML2OMML {
  /**
   * Construct a new MML2OMML converter
   *
   * @param mmlString - MathML string to convert
   * @param options - Optional configuration options
   */
  constructor(mmlString: string, options?: MML2OMMLOptions)

  /**
   * Run the conversion process
   */
  run(): void

  /**
   * Get the resulting OMML as a string
   *
   * @returns OMML string
   */
  getResult(): string
}
```

### packages/mathml2omml/src/helpers.js
```
export function getTextContent(node, trim = true) {
  let returnString = ''
  if (node.type === 'text') {
    let text = node.data.replace(/[\u2062]|[\u200B]/g, '')
    if (trim) {
      text = text.trim()
    }
    returnString += text
  } else if (node.children) {
    node.children.forEach((subNode) => {
      returnString += getTextContent(subNode, trim)
    })
  }
  return returnString
}
```

### packages/mathml2omml/src/walker.js
```
import * as mathmlHandlers from './mathml/index.js'
import { addScriptlevel } from './ooml/index.js'

export function walker(
  element,
  targetParent,
  previousSibling = false,
  nextSibling = false,
  ancestors = []
) {
  if (
    !previousSibling &&
    ['m:deg', 'm:den', 'm:e', 'm:fName', 'm:lim', 'm:num', 'm:sub', 'm:sup'].includes(
      targetParent.name
    )
  ) {
    // We are walking through the first element within one of the
    // elements where an <m:argPr> might occur. The <m:argPr> can specify
    // the scriptlevel, but it only makes sense if there is some content.
    // The fact that we are here means that there is at least one content item.
    // So we will check whether to add the m:rPr.
    // For possible parent types, see
    // https://docs.microsoft.com/en-us/dotnet/api/documentformat.openxml.math.argumentproperties?view=openxml-2.8.1#remarks
    addScriptlevel(targetParent, ancestors)
  }
  let targetElement
  const nameOrType = element.name || element.type
  if (mathmlHandlers[nameOrType]) {
    targetElement = mathmlHandlers[nameOrType](
      element,
      targetParent,
      previousSibling,
      nextSibling,
      ancestors
    )
  } else {
    if (nameOrType && nameOrType !== 'root') {
      console.warn(`Type not supported: ${nameOrType}`)
    }

    targetElement = targetParent
  }

  if (!targetElement) {
    // Target element hasn't been assigned, so don't handle children.
    return
  }
  if (element.children?.length) {
    ancestors = [...ancestors]
    ancestors.unshift(element)
    // Track nary body redirect: after a nary operator, redirect subsequent
    // siblings into its <m:e> until a relational operator (=, <, >, etc.) is
    // encountered.  Chains through nested nary operators (e.g. double
    // integrals ∫∫).
    let naryBodyTarget = null
    // Track prescript redirect: after a msubsup with empty base (e.g.
    // {}^{14}_{6}C), redirect the next sibling into <m:sPre>'s <m:e>.
    let prescriptTarget = null
    for (let i = 0; i < element.children.length; i++) {
      const child = element.children[i]
```

### packages/mathml2omml/src/index.js
```
import { parse, stringifyDoc } from './parse-stringify'
import { walker } from './walker.js'

class MML2OMML {
  constructor(mmlString, options = {}) {
    this.inString = mmlString
    this.inXML = parse(mmlString, options)
    this.outXML = false
    this.outString = false
  }

  run() {
    const outXML = {}
    walker({ children: this.inXML, type: 'root' }, outXML)
    this.outXML = outXML
  }

  getResult() {
    this.outString = stringifyDoc([this.outXML])
    return this.outString
  }
}

export const mml2omml = (mmlString, options) => {
  const converter = new MML2OMML(mmlString, options)
  converter.run()
  return converter.getResult()
}
```

### packages/mathml2omml/src/parse-stringify/parse-tag.js
```
const attrRE = /\s([^'"/\s><]+?)[\s/>]|([^\s=]+)=\s?(".*?"|'.*?')/g

export default function stringify(tag) {
  const res = {
    type: 'tag',
    name: '',
    voidElement: false,
    attribs: {},
    children: []
  }

  const tagMatch = tag.match(/<\/?([^\s]+?)[/\s>]/)
  if (tagMatch) {
    res.name = tagMatch[1]
    if (tag.charAt(tag.length - 2) === '/') {
      res.voidElement = true
    }

    // handle comment tag
    if (res.name.startsWith('!--')) {
      const endIndex = tag.indexOf('-->')
      return {
        type: 'comment',
        comment: endIndex !== -1 ? tag.slice(4, endIndex) : ''
      }
    }
  }

  const reg = new RegExp(attrRE)
  let result = null
  for (;;) {
    result = reg.exec(tag)

    if (result === null) {
      break
    }

    if (!result[0].trim()) {
      continue
    }

    if (result[1]) {
      const attr = result[1].trim()
      let arr = [attr, '']

      if (attr.indexOf('=') > -1) {
        arr = attr.split('=')
      }

      res.attribs[arr[0]] = arr[1]
      reg.lastIndex--
    } else if (result[2]) {
      res.attribs[result[2]] = result[3].trim().substring(1, result[3].length - 1)
    }
  }

  return res
}
```

### packages/mathml2omml/src/parse-stringify/stringify.js
```
function attrString(attribs) {
  const buff = []
  for (const key in attribs) {
    buff.push(`${key}="${attribs[key]}"`)
  }
  if (!buff.length) {
    return ''
  }
  return ` ${buff.join(' ')}`
}

function escapeXmlText(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stringify(buff, doc) {
  switch (doc.type) {
    case 'text':
      return buff + escapeXmlText(doc.data)
    case 'tag': {
      const voidElement =
        doc.voidElement || (!doc.children.length && doc.attribs['xml:space'] !== 'preserve')
      buff += `<${doc.name}${doc.attribs ? attrString(doc.attribs) : ''}${voidElement ? '/>' : '>'}`
      if (voidElement) {
        return buff
      }
      return `${buff + doc.children.reduce(stringify, '')}</${doc.name}>`
    }
    case 'comment':
      buff += `<!--${doc.comment}-->`
      return buff
  }
}

export function stringifyDoc(doc) {
  return doc.reduce((token, rootEl) => token + stringify('', rootEl), '')
}
```

### packages/mathml2omml/src/parse-stringify/parse.js
```
import * as entities from 'entities'

import parseTag from './parse-tag'

const tagRE = /<[a-zA-Z0-9\-!/](?:"[^"]*"|'[^']*'|[^'">])*>/g
const whitespaceRE = /^\s*$/

const textContainerNames = ['mtext', 'mi', 'mn', 'mo', 'ms']

// re-used obj for quick lookups of components
const empty = Object.create(null)

export function parse(html, options = {}) {
  const result = []
  const arr = []
  let current
  let level = -1

  html.replace(tagRE, (tag, index) => {
    const isOpen = tag.charAt(1) !== '/'
    const isComment = tag.startsWith('<!--')
    const start = index + tag.length
    const nextChar = html.charAt(start)
    let parent

    if (isComment) {
      const comment = parseTag(tag)

      // if we're at root, push new base node
      if (level < 0) {
        result.push(comment)
        return result
      }
      parent = arr[level]
      parent.children.push(comment)
      return result
    }

    if (isOpen) {
      level++

      current = parseTag(tag)
      if (current.type === 'tag' && options.components?.[current.name]) {
        current.type = 'component'
      }

      if (
        textContainerNames.includes(current.name) &&
        !current.voidElement &&
        nextChar &&
        nextChar !== '<'
      ) {
        const data = html.slice(start, html.indexOf('<', start)).trim()
        current.children.push({
          type: 'text',
          data: options.disableDecode ? data : entities.decodeXML(data)
        })
      }

      // if we're at root, push new base node
```

### packages/mathml2omml/src/parse-stringify/index.js
```
// Copied and adjusted from html-parse-stringify (MIT) https://github.com/HenrikJoreteg/html-parse-stringify/commit/ce46022f537ef9b050fac592f9fcc30bf838e5ba

export { parse } from './parse'
export { stringifyDoc } from './stringify'
```

### packages/mathml2omml/src/mathml/mmultiscripts.js
```
import { walker } from '../walker.js'

export function mmultiscripts(element, targetParent, previousSibling, nextSibling, ancestors) {
  if (element.children.length === 0) {
    // Don't use
    return
  }

  const base = element.children[0]
  const postSubs = []
  const postSupers = []
  const preSubs = []
  const preSupers = []
  const children = element.children.slice(1)
  let dividerFound = false
  children.forEach((child, index) => {
    if (child.name === 'mprescripts') {
      dividerFound = true
    } else if (child.name !== 'none') {
      if (index % 2) {
        if (dividerFound) {
          preSubs.push(child)
        } else {
          postSupers.push(child)
        }
      } else {
        if (dividerFound) {
          preSupers.push(child)
        } else {
          postSubs.push(child)
        }
      }
    }
  })
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const tempTarget = {
    children: []
  }
  walker(base, tempTarget, false, false, ancestors)
  let topTarget = tempTarget.children[0]

  if (postSubs.length || postSupers.length) {
    const subscriptTarget = {
      name: 'm:sub',
      type: 'tag',
      attribs: {},
      children: []
    }
    postSubs.forEach((subscript) => walker(subscript, subscriptTarget, false, false, ancestors))

    const superscriptTarget = {
      name: 'm:sup',
      type: 'tag',
      attribs: {},
      children: []
    }

    postSupers.forEach((superscript) =>
      walker(superscript, superscriptTarget, false, false, ancestors)
```

### packages/mathml2omml/src/mathml/msubsup.js
```
import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

export function msubsup(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Sub + superscript
  if (element.children.length !== 3) {
    // treat as mrow
    return targetParent
  }

  ancestors = [...ancestors]
  ancestors.unshift(element)

  const base = element.children[0]
  const subscript = element.children[1]
  const superscript = element.children[2]

  let topTarget
  //
  // m:nAry
  //
  // Conditions:
  // 1. base text must be nary operator
  // 2. no accents
  const naryChar = getNary(base)
  if (
    naryChar &&
    element.attribs?.accent?.toLowerCase() !== 'true' &&
    element.attribs?.accentunder?.toLowerCase() !== 'true'
  ) {
    topTarget = getNaryTarget(naryChar, element, 'subSup')
    element.isNary = true
  } else {
    // Check for empty base → prescript pattern (LaTeX {}^{sup}_{sub}X)
    const isEmptyBase = base.name === 'mrow' && (!base.children || base.children.length === 0)

    if (isEmptyBase) {
      topTarget = {
        type: 'tag',
        name: 'm:sPre',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:sPrePr',
            attribs: {},
            children: [
              {
                type: 'tag',
                name: 'm:ctrlPr',
                attribs: {},
                children: []
              }
            ]
          }
        ]
      }
      element.isPrescript = true
    } else {
      // Regular m:sSubSup
```

### packages/mathml2omml/src/mathml/mroot.js
```
import { getTextContent } from '../helpers.js'
import { walker } from '../walker.js'

export function mroot(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Root
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const base = element.children[0]
  const root = element.children[1]

  const baseTarget = {
    type: 'tag',
    name: 'm:e',
    attribs: {},
    children: []
  }
  walker(base, baseTarget, false, false, ancestors)

  const rootTarget = {
    type: 'tag',
    name: 'm:deg',
    attribs: {},
    children: []
  }
  walker(root, rootTarget, false, false, ancestors)

  const rootText = getTextContent(root)

  targetParent.children.push({
    type: 'tag',
    name: 'm:rad',
    attribs: {},
    children: [
      {
        type: 'tag',
        name: 'm:radPr',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:degHide',
            attribs: { 'm:val': rootText.length ? 'off' : 'on' },
            children: []
          }
        ]
      },
      rootTarget,
      baseTarget
    ]
  })
}
```

### packages/mathml2omml/src/mathml/munderover.js
```
import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

export function munderover(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Munderover
  if (element.children.length !== 3) {
    // treat as mrow
    return targetParent
  }

  ancestors = [...ancestors]
  ancestors.unshift(element)

  const base = element.children[0]
  const underscript = element.children[1]
  const overscript = element.children[2]

  //
  // m:nAry
  //
  // Conditions:
  // 1. base text must be nary operator
  // 2. no accents
  const naryChar = getNary(base)
  if (
    naryChar &&
    element.attributes?.accent?.toLowerCase() !== 'true' &&
    element.attributes?.accentunder?.toLowerCase() !== 'true'
  ) {
    const topTarget = getNaryTarget(naryChar, element, 'undOvr')
    element.isNary = true
    const subscriptTarget = {
      name: 'm:sub',
      type: 'tag',
      attribs: {},
      children: []
    }
    const superscriptTarget = {
      name: 'm:sup',
      type: 'tag',
      attribs: {},
      children: []
    }
    walker(underscript, subscriptTarget, false, false, ancestors)
    walker(overscript, superscriptTarget, false, false, ancestors)
    topTarget.children.push(subscriptTarget)
    topTarget.children.push(superscriptTarget)
    topTarget.children.push({ type: 'tag', name: 'm:e', attribs: {}, children: [] })
    targetParent.children.push(topTarget)
    return
  }

  // Fallback: m:limUpp()m:limlow

  const baseTarget = {
    name: 'm:e',
    type: 'tag',
    attribs: {},
    children: []
  }
```

### packages/mathml2omml/src/mathml/math.js
```
export function math(element, targetParent, previousSibling, nextSibling, ancestors) {
  targetParent.name = 'm:oMath'
  targetParent.attribs = {
    'xmlns:m': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'xmlns:w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  }
  targetParent.type = 'tag'
  targetParent.children = []
  return targetParent
}

export function semantics(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Ignore as default behavior
  return targetParent
}
```

### packages/mathml2omml/src/mathml/mfrac.js
```
import { walker } from '../walker.js'

export function mfrac(element, targetParent, previousSibling, nextSibling, ancestors) {
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }

  const numerator = element.children[0]
  const denumerator = element.children[1]
  const numeratorTarget = {
    name: 'm:num',
    type: 'tag',
    attribs: {},
    children: []
  }
  const denumeratorTarget = {
    name: 'm:den',
    type: 'tag',
    attribs: {},
    children: []
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  walker(numerator, numeratorTarget, false, false, ancestors)
  walker(denumerator, denumeratorTarget, false, false, ancestors)
  const lt = element.attribs?.linethickness
  const fracType = (lt === '0' || lt === '0px' || lt === '0em' || lt === '0pt') ? 'noBar' : 'bar'
  targetParent.children.push({
    type: 'tag',
    name: 'm:f',
    attribs: {},
    children: [
      {
        type: 'tag',
        name: 'm:fPr',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:type',
            attribs: {
              'm:val': fracType
            },
            children: []
          }
        ]
      },
      numeratorTarget,
      denumeratorTarget
    ]
  })
  // Don't iterate over children in the usual way.
}
```

### packages/mathml2omml/src/mathml/text_container.js
```
import { getStyle } from './text_style.js'

const STYLES = {
  bold: 'b',
  italic: 'i',
  'bold-italic': 'bi'
}

function textContainer(element, targetParent, previousSibling, nextSibling, ancestors, textType) {
  // isNary redirect is now handled in walker's child loop

  const hasMglyphChild = element.children?.find((element) => element.name === 'mglyph')
  const style = getStyle(element, ancestors, previousSibling?.style)
  element.style = style // Add it to element to make it comparable
  element.hasMglyphChild = hasMglyphChild
  const styleSame =
    Object.keys(style).every((key) => {
      const previousStyle = previousSibling?.style
      return previousStyle && style[key] === previousStyle[key]
    }) && previousSibling?.hasMglyphChild === hasMglyphChild
  const sameGroup = // Only group mtexts or mi, mn, mo with oneanother.
    textType === previousSibling?.name ||
    (['mi', 'mn', 'mo'].includes(textType) && ['mi', 'mn', 'mo'].includes(previousSibling?.name))
  let targetElement
  const lastChild = targetParent.children[targetParent.children.length - 1]
  if (sameGroup && styleSame && !hasMglyphChild && lastChild?.name === 'm:r') {
    targetElement = lastChild.children[lastChild.children.length - 1]
  } else {
    const rElement = {
      name: 'm:r',
      type: 'tag',
      attribs: {},
      children: []
    }

    if (style.variant) {
      const wrPr = {
        name: 'w:rPr',
        type: 'tag',
        attribs: {},
        children: []
      }
      if (style.variant.includes('bold')) {
        wrPr.children.push({ name: 'w:b', type: 'tag', attribs: {}, children: [] })
      }
      if (style.variant.includes('italic')) {
        wrPr.children.push({ name: 'w:i', type: 'tag', attribs: {}, children: [] })
      }
      rElement.children.push(wrPr)
      const mrPr = {
        name: 'm:rPr',
        type: 'tag',
        attribs: {},
        children: [
          {
            name: 'm:nor',
            type: 'tag',
            attribs: {},
            children: []
          }
```

### packages/mathml2omml/src/mathml/index.js
```
export { math, semantics } from './math.js'
export { menclose } from './menclose.js'
export { mfrac } from './mfrac.js'
export { mglyph } from './mglyph.js'
export { mmultiscripts } from './mmultiscripts.js'
export { mrow } from './mrow.js'
export { mspace } from './mspace.js'
export { msqrt } from './msqrt.js'
export { mstyle } from './mstyle.js'
export { msub } from './msub.js'
export { msubsup } from './msubsup.js'
export { msup } from './msup.js'
export { mtable, mtd, mtr } from './table.js'
export { munderover } from './munderover.js'
export { mtext, mi, mn, ms, mo } from './text_container.js'
export { munder, mover } from './under_or_over.js'
export { mroot } from './mroot.js'
export { text } from './text.js'
```

### packages/mathml2omml/src/mathml/text_style.js
```
import { getTextContent } from '../helpers.js'

export function getStyle(element, ancestors, previousStyle = {}) {
  const elAttributes = element.attribs || {}
  const color =
    elAttributes.mathcolor ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.color
    )?.attribs.color ||
    ''
  // const minsize = parseFloat(elAttributes.scriptminsize || ancestors.find(element => element.name === 'mstyle' && element.attribs && element.attribs.scriptminsize)?.attribs.scriptminsize || '8pt')
  // const sizemultiplier = parseFloat(elAttributes.scriptsizemultiplier || ancestors.find(element => element.name === 'mstyle' && element.attribs && element.attribs.scriptsizemultiplier)?.attribs.scriptsizemultiplier || '0.71')
  const size =
    elAttributes.mathsize ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.mathsize
    )?.attribs.mathsize ||
    ''
  const scriptlevel =
    elAttributes.scriptlevel ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.scriptlevel
    )?.attribs.scriptlevel ||
    ''
  const background =
    elAttributes.mathbackground ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.mathbackground
    )?.attribs.mathbackground ||
    ''
  let variant =
    elAttributes.mathvariant ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.mathvariant
    )?.attribs.mathvariant ||
    ''
  if (variant === 'b-i') {
    variant = 'bold-italic'
  }
  const fontweight =
    elAttributes.fontweight ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.fontweight
    )?.attribs.fontweight ||
    ''
  if (fontweight === 'bold' && !['bold', 'bold-italic'].includes(variant)) {
    if (variant.includes('italic')) {
      variant = 'bold-italic'
    } else {
      variant = 'bold'
    }
  } else if (fontweight === 'normal' && ['bold', 'bold-italic'].includes(variant)) {
    if (variant.includes('italic')) {
      variant = 'italic'
    } else {
      variant = ''
    }
  }
  const fontstyle =
    elAttributes.fontstyle ||
```

### packages/mathml2omml/src/mathml/msub.js
```
import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

export function msub(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Subscript
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const base = element.children[0]
  const subscript = element.children[1]

  let topTarget
  //
  // m:nAry
  //
  // Conditions:
  // 1. base text must be nary operator
  // 2. no accents
  const naryChar = getNary(base)
  if (
    naryChar &&
    element.attribs?.accent?.toLowerCase() !== 'true' &&
    element.attribs?.accentunder?.toLowerCase() !== 'true'
  ) {
    topTarget = getNaryTarget(naryChar, element, 'subSup', false, true)
    element.isNary = true
  } else {
    // Check for empty base → prescript pattern (LaTeX {}_{sub}X)
    const isEmptyBase = base.name === 'mrow' && (!base.children || base.children.length === 0)

    if (isEmptyBase) {
      topTarget = {
        type: 'tag',
        name: 'm:sPre',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:sPrePr',
            attribs: {},
            children: [
              {
                type: 'tag',
                name: 'm:ctrlPr',
                attribs: {},
                children: []
              }
            ]
          }
        ]
      }
      element.isPrescript = true
    } else {
      const baseTarget = {
        name: 'm:e',
        type: 'tag',
        attribs: {},
```

### packages/mathml2omml/src/mathml/text.js
```
export function text(element, targetParent, previousSibling, nextSibling, ancestors) {
  let text = element.data.replace(/[\u2062]|[\u200B]/g, '')
  if (ancestors.find((element) => ['mi', 'mn', 'mo'].includes(element.name))) {
    text = text.replace(/\s/g, '')
  } else {
    const ms = ancestors.find((element) => element.name === 'ms')
    if (ms) {
      text = (ms.attribs?.lquote || '"') + text + (ms.attribs?.rquote || '"')
    }
  }
  if (text.length) {
    if (
      targetParent.children.length &&
      targetParent.children[targetParent.children.length - 1].type === 'text'
    ) {
      targetParent.children[targetParent.children.length - 1].data += text
    } else {
      targetParent.children.push({
        type: 'text',
        data: text
      })
    }
  }
  return targetParent
}
```

### packages/mathml2omml/src/mathml/mstyle.js
```
export function mstyle(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Ignore as default behavior
  return targetParent
}
```

### packages/mathml2omml/src/mathml/menclose.js
```
export function menclose(element, targetParent, previousSibling, nextSibling, ancestors) {
  const type = element.attribs?.notation?.split(' ')[0] || 'longdiv'

  const targetElement = {
    type: 'tag',
    name: 'm:e',
    attribs: {},
    children: []
  }

  if (type === 'longdiv') {
    targetParent.children.push({
      type: 'tag',
      name: 'm:rad',
      attribs: {},
      children: [
        {
          type: 'tag',
          name: 'm:radPr',
          attribs: {},
          children: [{ type: 'tag', name: 'm:degHide', attribs: { 'm:val': 'on' }, children: [] }]
        },
        { type: 'tag', name: 'm:deg', attribs: {}, children: [] },
        targetElement
      ]
    })
  } else {
    const hide = {
      t: { type: 'tag', name: 'm:hideTop', attribs: { 'm:val': 'on' }, children: [] },
      b: { type: 'tag', name: 'm:hideBot', attribs: { 'm:val': 'on' }, children: [] },
      l: { type: 'tag', name: 'm:hideLeft', attribs: { 'm:val': 'on' }, children: [] },
      r: { type: 'tag', name: 'm:hideRight', attribs: { 'm:val': 'on' }, children: [] }
    }
    const borderBoxPr = { type: 'tag', name: 'm:borderBoxPr', attribs: {}, children: [] }

    const containerElement = {
      type: 'tag',
      name: 'm:borderBox',
      attribs: {},
      children: []
    }
    switch (type) {
      case 'actuarial':
      case 'radical':
      case 'box':
        containerElement.children = [targetElement]
        break
      case 'left':
      case 'roundedbox':
        borderBoxPr.children = [hide.t, hide.b, hide.r]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'right':
      case 'circle':
        borderBoxPr.children = [hide.t, hide.b, hide.l]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'top':
        borderBoxPr.children = [hide.b, hide.l, hide.r]
        containerElement.children = [borderBoxPr, targetElement]
```

### packages/mathml2omml/src/mathml/msup.js
```
import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

export function msup(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Superscript
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const base = element.children[0]
  const superscript = element.children[1]

  let topTarget
  //
  // m:nAry
  //
  // Conditions:
  // 1. base text must be nary operator
  // 2. no accents
  const naryChar = getNary(base)
  if (
    naryChar &&
    element.attribs?.accent?.toLowerCase() !== 'true' &&
    element.attribs?.accentunder?.toLowerCase() !== 'true'
  ) {
    topTarget = getNaryTarget(naryChar, element, 'subSup', true)
    element.isNary = true
    topTarget.children.push({ type: 'tag', name: 'm:sub' })
  } else {
    // Check for empty base → prescript pattern (LaTeX {}^{sup}X)
    const isEmptyBase = base.name === 'mrow' && (!base.children || base.children.length === 0)

    if (isEmptyBase) {
      topTarget = {
        type: 'tag',
        name: 'm:sPre',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:sPrePr',
            attribs: {},
            children: [
              {
                type: 'tag',
                name: 'm:ctrlPr',
                attribs: {},
                children: []
              }
            ]
          }
        ]
      }
      element.isPrescript = true
    } else {
      const baseTarget = {
        name: 'm:e',
        type: 'tag',
```

### packages/mathml2omml/src/mathml/msqrt.js
```
export function msqrt(element, targetParent, previousSibling, nextSibling, ancestors) {
  const targetElement = {
    name: 'm:e',
    type: 'tag',
    attribs: {},
    children: []
  }
  targetParent.children.push({
    name: 'm:rad',
    type: 'tag',
    attribs: {},
    children: [
      {
        name: 'm:radPr',
        type: 'tag',
        attribs: {},
        children: [
          {
            name: 'm:degHide',
            type: 'tag',
            attribs: {
              'm:val': 'on'
            },
            children: []
          }
        ]
      },
      {
        name: 'm:deg',
        type: 'tag',
        attribs: {},
        children: []
      },
      targetElement
    ]
  })
  return targetElement
}
```

### packages/mathml2omml/src/mathml/mrow.js
```
export function mrow(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Detect fence pattern: <mo fence="true">OPEN ... <mo fence="true">CLOSE
  // Convert to OMML <m:d> delimiter (e.g. binomial, \left(\right))
  const children = element.children || []
  if (children.length >= 2) {
    const first = children[0]
    const last = children[children.length - 1]
    if (first?.name === 'mo' && first?.attribs?.fence === 'true' &&
        last?.name === 'mo' && last?.attribs?.fence === 'true') {
      const begChar = first.children?.[0]?.data || '('
      const endChar = last.children?.[0]?.data || ')'
      const dNode = {
        type: 'tag', name: 'm:d', attribs: {}, children: [
          { type: 'tag', name: 'm:dPr', attribs: {}, children: [
            { type: 'tag', name: 'm:begChr', attribs: { 'm:val': begChar }, children: [] },
            { type: 'tag', name: 'm:endChr', attribs: { 'm:val': endChar }, children: [] },
            { type: 'tag', name: 'm:ctrlPr', attribs: {}, children: [] }
          ]},
          { type: 'tag', name: 'm:e', attribs: {}, children: [] }
        ]
      }
      targetParent.children.push(dNode)
      // Mark fence operators so the walker child loop skips them
      first.skipInWalker = true
      last.skipInWalker = true
      // Return <m:e> as target — inner children go here
      return dNode.children[1]
    }
  }
  // isNary redirect is now handled in walker's child loop
  return targetParent
}
```

### packages/mathml2omml/src/mathml/table.js
```
export function mtable(element, targetParent, previousSibling, nextSibling, ancestors) {
  const cellsPerRowCount = Math.max(...element.children.map((row) => row.children.length))
  const targetElement = {
    name: 'm:m',
    type: 'tag',
    attribs: {},
    children: [
      {
        name: 'm:mPr',
        type: 'tag',
        attribs: {},
        children: [
          {
            name: 'm:baseJc',
            type: 'tag',
            attribs: {
              'm:val': 'center'
            },
            children: []
          },
          {
            name: 'm:plcHide',
            type: 'tag',
            attribs: {
              'm:val': 'on'
            },
            children: []
          },
          {
            name: 'm:mcs',
            type: 'tag',
            attribs: {},
            children: [
              {
                name: 'm:mc',
                type: 'tag',
                attribs: {},
                children: [
                  {
                    name: 'm:mcPr',
                    type: 'tag',
                    attribs: {},
                    children: [
                      {
                        name: 'm:count',
                        type: 'tag',
                        attribs: {
                          'm:val': cellsPerRowCount.toString()
                        },
                        children: []
                      },
                      {
                        name: 'm:mcJc',
                        type: 'tag',
                        attribs: {
                          'm:val': 'center'
                        },
                        children: []
                      }
                    ]
```

### packages/mathml2omml/src/mathml/under_or_over.js
```
import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

import { getTextContent } from '../helpers.js'

const UPPER_COMBINATION = {
  '\u2190': '\u20D6', // arrow left
  '\u27F5': '\u20D6', // arrow left, long
  '\u2192': '\u20D7', // arrow right
  '\u27F6': '\u20D7', // arrow right, long
  '\u00B4': '\u0301', // accute
  '\u02DD': '\u030B', // accute, double
  '\u02D8': '\u0306', // breve
  ˇ: '\u030C', // caron
  '\u00B8': '\u0312', // cedilla
  '\u005E': '\u0302', // circumflex accent
  '\u00A8': '\u0308', // diaresis
  '\u02D9': '\u0307', // dot above
  '\u0060': '\u0300', // grave accent
  '\u002D': '\u0305', // hyphen -> overline
  '\u00AF': '\u0305', // macron
  '\u2212': '\u0305', // minus -> overline
  '\u002E': '\u0307', // period -> dot above
  '\u007E': '\u0303', // tilde
  '\u02DC': '\u0303' // small tilde
}

function underOrOver(element, targetParent, previousSibling, nextSibling, ancestors, direction) {
  // Munder/Mover

  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }

  ancestors = [...ancestors]
  ancestors.unshift(element)

  const base = element.children[0]
  const script = element.children[1]

  // Munder/Mover can be translated to ooml in different ways.

  // First we check for m:nAry.
  //
  // m:nAry
  //
  // Conditions:
  // 1. base text must be nary operator
  // 2. no accents
  const naryChar = getNary(base)

  if (
    naryChar &&
    element.attribs?.accent?.toLowerCase() !== 'true' &&
    element.attribs?.accentunder?.toLowerCase() !== 'true'
  ) {
    const topTarget = getNaryTarget(
      naryChar,
      element,
```

### packages/mathml2omml/src/mathml/mglyph.js
```
export function mglyph(element, targetParent, previousSibling, nextSibling, ancestors) {
  // No support in omml. Output alt text.
  if (element.attribs?.alt) {
    targetParent.children.push({
      type: 'text',
      data: element.attribs.alt
    })
  }
}
```

### packages/mathml2omml/src/mathml/mspace.js
```
export function mspace(element, targetParent, previousSibling, nextSibling, ancestors) {
  targetParent.children.push({
    name: 'm:r',
    type: 'tag',
    attribs: {},
    children: [
      {
        name: 'm:t',
        type: 'tag',
        attribs: {
          'xml:space': 'preserve'
        },
        children: [
          {
            type: 'text',
            data: ' '
          }
        ]
      }
    ]
  })
}
```

### packages/mathml2omml/src/ooml/scriptlevel.js
```
export function addScriptlevel(target, ancestors) {
  const scriptlevel = ancestors.find((ancestor) => ancestor.attribs?.scriptlevel)?.attribs
    ?.scriptlevel
  if (['0', '1', '2'].includes(scriptlevel)) {
    target.children.unshift({
      type: 'tag',
      name: 'm:argPr',
      attribs: {},
      children: [
        {
          type: 'tag',
          name: 'm:scrLvl',
          attribs: { 'm:val': scriptlevel },
          children: []
        }
      ]
    })
  }
}
```

### packages/mathml2omml/src/ooml/nary.js
```
import { getTextContent } from '../helpers.js'

const NARY_REGEXP = /^[\u220f-\u2211]|[\u2229-\u2233]|[\u22c0-\u22c3]$/
const GROW_REGEXP = /^\u220f|\u2211|[\u2229-\u222b]|\u222e|\u222f|\u2232|\u2233|[\u22c0-\u22c3]$/

export function getNary(node) {
  // Check if node contains only a nary operator.
  const text = getTextContent(node)
  if (NARY_REGEXP.test(text)) {
    return text
  }
  return false
}

export function getNaryTarget(naryChar, element, type, subHide = false, supHide = false) {
  const stretchy = element.attribs?.stretchy
  const grow =
    stretchy === 'true' ? '1' : stretchy === 'false' ? '0' : GROW_REGEXP.test(naryChar) ? '1' : '0'
  return {
    type: 'tag',
    name: 'm:nary',
    attribs: {},
    children: [
      {
        type: 'tag',
        name: 'm:naryPr',
        attribs: {},
        children: [
          { type: 'tag', name: 'm:chr', attribs: { 'm:val': naryChar }, children: [] },
          { type: 'tag', name: 'm:limLoc', attribs: { 'm:val': type }, children: [] },
          { type: 'tag', name: 'm:grow', attribs: { 'm:val': grow }, children: [] },
          {
            type: 'tag',
            name: 'm:subHide',
            attribs: { 'm:val': subHide ? 'on' : 'off' },
            children: []
          },
          {
            type: 'tag',
            name: 'm:supHide',
            attribs: { 'm:val': supHide ? 'on' : 'off' },
            children: []
          }
        ]
      }
    ]
  }
}
```

### packages/mathml2omml/src/ooml/index.js
```
export { getNary, getNaryTarget } from './nary.js'
export { addScriptlevel } from './scriptlevel.js'
```


## AI Task Hints
- run production readiness audits
- detect unused dependencies
- analyze API security
- generate integration tests
- suggest deployment configs
