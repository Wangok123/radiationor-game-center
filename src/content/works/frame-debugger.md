---
title: Frame Debugger
type: Unity editor utility
date: 2025
platform: Unity Editor
status: Maintained
summary: An editor window for tracking gameplay events, inspecting state transitions, and exporting concise debug traces for playtest review.
tech: Unity Editor | UI Toolkit | C# | JSON
role: Tool design and implementation
highlight: Reduced time spent reproducing state bugs by making event order visible in a single timeline.
image: https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&w=1200&q=85
---

Frame Debugger treats debugging as a communication problem. It collects events with lightweight metadata, groups them by play session, and makes the resulting trace easy to scan during a review.

