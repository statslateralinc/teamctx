# StatsLateral Main Website

Marketing + resources site for StatsLateral. Content (blog / resources) is authored in
Google Docs and published into this repo.

## Stack

<!-- Fill in when confirmed -->

- Framework: `<e.g. Next.js / Astro / Gatsby>`
- Content format: `<MDX / Markdown / CMS>`
- Deploy target: `<Vercel / Netlify / Cloudflare Pages>`
- Package manager: `<pnpm / npm / yarn>`

## Directory map

<!-- Fill in real paths -->

- Resources / blog posts: `src/content/resources/` (one file per article)
- Shared components: `src/components/`
- Images/assets for posts: `public/resources/<slug>/`

## Publishing a new article

Source of truth for article drafts is Google Drive. Titles map to files as follows:

1. Fetch the article from the Google Doc the user names. Do NOT read the entire doc —
   locate the specific title (H1) they gave, then read only that section until the next
   H1. If the doc is large, search for the title string first.
2. Create the article file at `src/content/resources/<kebab-slug>.mdx` with front-matter:

   <!-- Fill in front-matter fields when confirmed -->
