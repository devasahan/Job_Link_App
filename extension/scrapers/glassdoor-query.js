/** Glassdoor JobSearchResultsQuery — same GraphQL as JobSpy. */
export const GLASSDOOR_QUERY = `
query JobSearchResultsQuery(
    $excludeJobListingIds: [Long!],
    $keyword: String,
    $locationId: Int,
    $locationType: LocationTypeEnum,
    $numJobsToShow: Int!,
    $pageCursor: String,
    $pageNumber: Int,
    $filterParams: [FilterParams],
    $originalPageUrl: String,
    $seoFriendlyUrlInput: String,
    $parameterUrlInput: String,
    $seoUrl: Boolean
) {
    jobListings(
        contextHolder: {
            searchParams: {
                excludeJobListingIds: $excludeJobListingIds,
                keyword: $keyword,
                locationId: $locationId,
                locationType: $locationType,
                numPerPage: $numJobsToShow,
                pageCursor: $pageCursor,
                pageNumber: $pageNumber,
                filterParams: $filterParams,
                originalPageUrl: $originalPageUrl,
                seoFriendlyUrlInput: $seoFriendlyUrlInput,
                parameterUrlInput: $parameterUrlInput,
                seoUrl: $seoUrl,
                searchType: SR
            }
        }
    ) {
        jobListings {
            ...JobView
            __typename
        }
        paginationCursors {
            cursor
            pageNumber
            __typename
        }
        totalJobsCount
        __typename
    }
}

fragment JobView on JobListingSearchResult {
    jobview {
        header {
            adOrderSponsorshipLevel
            ageInDays
            employer {
                id
                name
                __typename
            }
            employerNameFromSearch
            jobTitleText
            locationName
            locationType
            __typename
        }
        job {
            description
            jobTitleText
            listingId
            __typename
        }
        __typename
    }
    __typename
}
`;

export const FALLBACK_CSRF =
  "Ft6oHEWlRZrxDww95Cpazw:0pGUrkb2y3TyOpAIqF2vbPmUXoXVkD3oEGDVkvfeCerceQ5-n8mBg3BovySUIjmCPHCaW0H2nQVdqzbtsYqf4Q:wcqRqeegRUa9MVLJGyujVXB7vWFPjdaS1CtrrzJq-ok";
