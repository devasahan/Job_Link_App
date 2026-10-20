import { test } from "node:test";
import assert from "node:assert/strict";

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

test("a board without descriptions keeps its jobs when the stack was searched by the board", () => {
  // LinkedIn / ZipRecruiter cards: no description, stack not passed
  assert.ok(keeps(job({ title: "Senior Frontend Engineer" }), { title: "Frontend Engineer" }));
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
