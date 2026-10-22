import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  filterByRequest,
  matchesEmployment,
  requiredYearsFromText,
  titleMatches,
} from "../extension/scrapers/util.js";

const job = (fields) => ({ title: "Software Engineer", description: "", ...fields });
const keeps = (j, opts) => filterByRequest([j], opts).length === 1;

test("title words must be in the job title", () => {
  assert.ok(titleMatches("Sr Front-End Eng", "Senior Frontend Engineer"));
  assert.ok(titleMatches("Engineering Manager", "engineer manager"));
  assert.ok(!titleMatches("Product Designer", "Software Engineer"));
});

test("stack words match whole words only", () => {
  const desc = (description) => job({ description });
  assert.ok(keeps(desc("We use React and TypeScript."), { stack: "React TypeScript" }));
  assert.ok(!keeps(desc("We use React."), { stack: "React TypeScript" }));
  assert.ok(!keeps(desc("Join Google today"), { stack: "Go" }));
  assert.ok(keeps(desc("Services in Go and golang tooling"), { stack: "Go" }));
  assert.ok(!keeps(desc("JavaScript only"), { stack: "Java" }));
  assert.ok(!keeps(desc("Comply with labor laws"), { stack: "AWS" }));
  assert.ok(keeps(desc("Deploy on AWS."), { stack: "aws" }));
});

test("stack spelling variants match", () => {
  const desc = (description) => job({ description });
  assert.ok(keeps(desc("NodeJS backend"), { stack: "Node.js" }));
  assert.ok(keeps(desc("Node.js backend"), { stack: "node" }));
  assert.ok(keeps(desc("React.js front end"), { stack: "React" }));
  assert.ok(keeps(desc("PostgreSQL 15"), { stack: "Postgres" }));
  assert.ok(keeps(desc("ASP.NET Core services"), { stack: ".NET" }));
  assert.ok(keeps(desc("C# and C++"), { stack: "C#, C++" }));
  assert.ok(!keeps(desc("C++ only"), { stack: "C#" }));
});

test("stack also matches the title", () => {
  assert.ok(keeps(job({ title: "React Developer" }), { stack: "react" }));
});

test("years: the requirement shapes are read", () => {
  assert.equal(requiredYearsFromText("5+ years of experience"), 5);
  assert.equal(requiredYearsFromText("3-5 years experience with React"), 3);
  assert.equal(requiredYearsFromText("4 years' experience"), 4);
  assert.equal(requiredYearsFromText("minimum of 6 years of professional software experience"), 6);
  assert.equal(requiredYearsFromText("5 or more years of experience"), 5);
  assert.equal(requiredYearsFromText("Experience: 7+ years"), 7);
  assert.equal(requiredYearsFromText("experience of 3-5 years in backend work"), 3);
  assert.equal(requiredYearsFromText("2+ years of experience; 8+ years of total experience"), 8);
  assert.equal(requiredYearsFromText("12+ years of experience leading platform teams"), 12);
  assert.equal(requiredYearsFromText("No experience needed"), null);
});

test("years: company blurbs are not requirements", () => {
  assert.equal(
    requiredYearsFromText(
      "Our company has over 25 years of industry experience. Need 2+ years of experience."
    ),
    2
  );
  assert.equal(
    requiredYearsFromText("With 20 years in the market and experience serving clients"),
    null
  );
  assert.equal(requiredYearsFromText("We have 15 years of experience in fintech."), null);
  assert.equal(
    requiredYearsFromText("Our founders bring 12 years of combined experience. 3+ years of experience required."),
    3
  );
  // "We" is not a blurb on its own
  assert.equal(
    requiredYearsFromText("We are looking for someone with 5+ years of experience"),
    5
  );
  assert.equal(requiredYearsFromText("The ideal candidate has 4+ years of experience"), 4);
});

test("years filter keeps jobs at or under the limit + 0.5", () => {
  const withYears = (n) => job({ years_required: n });
  assert.ok(keeps(withYears(5), { years: 5 }));
  assert.ok(keeps(withYears(5.5), { years: 5 }));
  assert.ok(!keeps(withYears(6), { years: 5 }));
  assert.ok(keeps(job({}), { years: 5 }));
});

test("employment type", () => {
  // A job about contracts is not a contract job
  assert.ok(matchesEmployment(job({ title: "Contract Manager" }), "fulltime"));
  assert.ok(matchesEmployment(job({ title: "Contracting Officer" }), "fulltime"));
  assert.ok(!matchesEmployment(job({ title: "Software Engineer (Contract)" }), "fulltime"));
  assert.ok(!matchesEmployment(job({ title: "Contract Software Engineer" }), "fulltime"));
  // Dice lists the type as CONTRACTS
  assert.ok(!matchesEmployment(job({ listing_type: "CONTRACTS" }), "fulltime"));
  assert.ok(matchesEmployment(job({ listing_type: "CONTRACTS" }), "contract"));
  assert.ok(!matchesEmployment(job({ listing_type: "Part-time" }), "fulltime"));
  assert.ok(matchesEmployment(job({ listing_type: "Full-time, Contract" }), "contract"));
  // Unstated stays
  assert.ok(matchesEmployment(job({}), "contract"));
});

test("years: a skipped number never hides the requirement after it", () => {
  assert.equal(requiredYearsFromText("Must be 18 years old. 6+ years of experience required."), 6);
  assert.equal(requiredYearsFromText("We have 10 years in the market. 3+ years of experience required."), 3);
  assert.equal(requiredYearsFromText("Our company has 8 years in business. 6+ years of experience required."), 6);
  assert.equal(requiredYearsFromText("Founded 20 years ago. 5+ years of experience in React required."), 5);
  assert.equal(requiredYearsFromText("Our company has 25 years of experience 4+ years of experience needed"), 4);
  assert.equal(requiredYearsFromText("We have 10-12 years of experience. 4+ years of experience required."), 4);
  assert.equal(requiredYearsFromText("Must be at least 18 years of age 5+ years of experience with React"), 5);
});

test("years: combined / cumulative experience is a real requirement", () => {
  assert.equal(requiredYearsFromText("5+ years of combined experience in backend and DevOps."), 5);
  assert.equal(requiredYearsFromText("Minimum 5 years cumulative experience in software development."), 5);
  assert.equal(requiredYearsFromText("5+ years of .NET experience"), 5);
});

test("years: 'experience of N years' company blurbs are skipped", () => {
  assert.equal(
    requiredYearsFromText("Acme is a consultancy with an experience of 12 years in IT services. Need 2+ years of experience."),
    2
  );
  assert.equal(requiredYearsFromText("Experience: 4+ years in Go"), 4);
});

test("employment: smart contracts and plural contracts aren't contract jobs", () => {
  for (const title of [
    "Smart Contracts Engineer",
    "Senior Smart Contracts Developer (Solidity)",
    "Software Engineer - Contracts Platform",
    "Director of Contracts",
  ]) {
    assert.ok(matchesEmployment(job({ title }), "fulltime"), title);
  }
});

test("employment: 'Contract Lead …' titles are still contract jobs", () => {
  for (const title of [
    "Contract Lead Software Engineer",
    "Contract Associate Software Engineer",
    "Contract Director of Engineering",
  ]) {
    assert.ok(!matchesEmployment(job({ title }), "fulltime"), title);
  }
});

test("stack: framework names don't match everyday words", () => {
  const desc = (description) => job({ description });
  assert.ok(!keeps(desc("We are building the next generation of payments"), { stack: "Next.js" }));
  assert.ok(keeps(desc("Next.js and NextJS apps"), { stack: "Next.js" }));
  assert.ok(keeps(desc("Built on NextJS"), { stack: "next.js" }));
  assert.ok(!keeps(desc("Drive net-new revenue; competitive net salary"), { stack: ".NET" }));
  assert.ok(keeps(desc("ASP.NET Core services"), { stack: "dotnet" }));
  assert.ok(!keeps(desc("Express your ideas"), { stack: "Express.js" }));
  assert.ok(!keeps(desc("Our objective is to ship Swift apps"), { stack: "Objective-C" }));
  assert.ok(keeps(desc("iOS in Objective-C and Swift"), { stack: "Objective-C" }));
});

test("stack: versions and joined names still match", () => {
  const desc = (description) => job({ description });
  assert.ok(keeps(desc("Strong modern C++17 skills"), { stack: "C++" }));
  assert.ok(keeps(desc("Python3 scripting"), { stack: "Python" }));
  assert.ok(keeps(desc("React+Redux frontend"), { stack: "React Redux" }));
  assert.ok(keeps(desc("SpringBoot services"), { stack: "Spring Boot" }));
  assert.ok(!keeps(desc("Java 17"), { stack: "JavaScript" }));
});

test("years: 'combined experience' is a blurb only when the sentence is about the company", () => {
  assert.equal(
    requiredYearsFromText("12 years of combined experience across our leadership. 3+ years of experience required."),
    3
  );
  assert.equal(requiredYearsFromText("5+ years of combined experience in backend and DevOps."), 5);
});

test("years: 'experience of N years' needs a company owner right before it to be a blurb", () => {
  assert.equal(requiredYearsFromText("We are looking for a Senior Go engineer with experience of 5+ years building APIs."), 5);
  assert.equal(requiredYearsFromText("Our client needs a Java developer Experience: 8+ years"), 8);
  assert.equal(requiredYearsFromText("Join our team and bring experience - 4 years in React"), 4);
  assert.equal(requiredYearsFromText("What we're looking for Experience: 6+ years in Go"), 6);
  assert.equal(requiredYearsFromText("Our company has experience of 12 years in fintech."), null);
});

test("stack and title: Dot Net is .NET", () => {
  assert.ok(titleMatches("Sr. Dot Net Developer", ".NET Developer"));
  assert.ok(titleMatches(".NET Developer", "Dot Net Developer"));
  assert.ok(keeps(job({ description: "Dot Net Developer with C#" }), { stack: ".NET" }));
  assert.ok(!keeps(job({ description: "net-new revenue" }), { stack: ".NET" }));
});

test("stack: bare Express / Next / Nest find the .js frameworks", () => {
  const desc = (description) => job({ description });
  assert.ok(keeps(desc("Node, Express.js, MongoDB"), { stack: "Node Express" }));
  assert.ok(keeps(desc("NodeJS/ExpressJS APIs"), { stack: "Node Express" }));
  assert.ok(keeps(desc("Next.js app router"), { stack: "Next" }));
  assert.ok(keeps(desc("Built with NestJS"), { stack: "Nest" }));
  assert.ok(!keeps(desc("We are building the next generation"), { stack: "Next.js" }));
  assert.ok(!keeps(desc("Express your ideas"), { stack: "Express.js" }));
});

test("years: 'experience of N years' is a company blurb unless the sentence is hiring", () => {
  for (const blurb of [
    "ABC Technologies is an IT services firm having experience of 12 years in staffing. Java developer needed.",
    "XYZ is a staffing company that has experience of 12 years.",
    "Our company, with an experience of 12 years, is hiring juniors.",
    "We are a team of engineers with experience of 10 years in fintech.",
    "Acme is a consultancy with an experience of 12 years in IT services.",
  ]) {
    assert.equal(requiredYearsFromText(blurb), null, blurb);
  }
  assert.equal(requiredYearsFromText("We are looking for someone with experience of 5 years in React."), 5);
  assert.equal(requiredYearsFromText("Our client needs a developer with experience of 6 years."), 6);
  assert.equal(requiredYearsFromText("Our team needs an engineer with experience of 3-5 years."), 3);
  assert.equal(requiredYearsFromText("The ideal candidate has experience of 4 years."), 4);
});

test("years: sentence fixtures", () => {
  const lines = readFileSync(new URL("./fixtures/years.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  for (const line of lines) {
    const [text, expected] = line.split(/\s+=>\s+/);
    const want = expected.trim() === "null" ? null : Number(expected);
    assert.equal(requiredYearsFromText(text.replace(/\\n/g, "\n")), want, text);
  }
});

test("employment: Both keeps full-time and contract, drops part-time and internships", () => {
  assert.ok(matchesEmployment(job({ listing_type: "Full-time" }), "both"));
  assert.ok(matchesEmployment(job({ listing_type: "CONTRACTS" }), "both"));
  assert.ok(matchesEmployment(job({ title: "Contract Software Engineer" }), "both"));
  assert.ok(matchesEmployment(job({ listing_type: "Full-time, Contract" }), "both"));
  assert.ok(matchesEmployment(job({}), "both"), "unstated stays");
  assert.ok(!matchesEmployment(job({ listing_type: "Part-time" }), "both"));
  assert.ok(!matchesEmployment(job({ title: "Software Engineering Intern" }), "both"));
  assert.ok(keeps(job({ listing_type: "Contract" }), { jobType: "both" }));
  assert.ok(!keeps(job({ listing_type: "Internship" }), { jobType: "both" }));
});

test("title: developer and engineer are the same job", () => {
  assert.ok(titleMatches("Python Engineer", "Python Developer"));
  assert.ok(titleMatches("Senior Python Developer", "Python Engineer"));
  assert.ok(titleMatches("Senior Software Developer", "Software Engineer"));
  assert.ok(titleMatches("Backend Engineer II", "Backend Developer"));
  assert.ok(titleMatches("Sr. Software Dev", "Software Engineer"));
  assert.ok(titleMatches("Software Developer", "SWE"));
  assert.ok(titleMatches("AI Developer", "AI Engineer"));
  assert.ok(!titleMatches("Product Designer", "Python Developer"));
  assert.ok(!titleMatches("Java Engineer", "Python Developer"));
});
