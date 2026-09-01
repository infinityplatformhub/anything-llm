Ruling: Restore response.locals.apiKey compatibility object in middleware — existing check and disconnect handlers consume its id — wrong choice would leave valid extension keys returning 500.
Ruling: Preserve response.locals.apiKeyContext unchanged — scoped authorization and actor resolution depend on its current shape — wrong choice could regress authorization behavior.
Ruling: Exercise routes through Express and PostgreSQL with real model-created keys — unit mocks would miss middleware-to-handler locals contract — wrong choice could allow recurrence.
