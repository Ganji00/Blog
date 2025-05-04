export const SITE = {
  website: "https://ganji00.github.io/", // replace this with your deployed domain
  author: "Mateusz Kiersnowski",
  profile: "",
  desc: "Personal blog of Mateusz Kiersnowski. I write about software development, technology, and my personal projects.",
  title: "Mateusz Kiersnowski",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: false,
  showBackButton: true, // show back button in post detail
  editPost: {
    enabled: false,  // TODO: do i want to enable it?
    text: "Suggest Changes",
    url: "https://github.com/satnaing/astro-paper/edit/main/",
  },
  dynamicOgImage: true,
  lang: "en", // html lang code. Set this empty and default will be "en"
  timezone: "Europe/Warsaw", // Default global timezone (IANA format) https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
} as const;
