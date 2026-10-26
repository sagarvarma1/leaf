/**
 * Leaf's block data model. Mirrors Notion's public model: everything is a block, pages
 * included. A block has a type, a free-form `properties` JSON bag, a `parent_id` pointer
 * up the tree and an ordered `content` array of child ids down the tree.
 */

export type ContentBlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "toggle"
  | "quote"
  | "callout"
  | "code"
  | "divider"
  | "image"
  | "link_to_page"
  | "column_list"
  | "column"
  | "synced_block";

export type BlockType = ContentBlockType | "page" | "database";

export const CONTENT_BLOCK_TYPES: ContentBlockType[] = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "divider",
  "image",
  "link_to_page",
  "column_list",
  "column",
  "synced_block",
];

export interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
  color?: string;
}

/** One run of rich text. A run is either plain text with marks, or a mention. */
export interface RichTextRun {
  text: string;
  marks?: Marks;
  mention?: { type: "page" | "user"; id: string };
}
export type RichText = RichTextRun[];

/** A block as stored in SQLite and served by the REST API. */
export interface Block {
  id: string;
  type: BlockType;
  workspace_id: string;
  parent_id: string | null;
  /** For content blocks: the page whose document owns them. Null for pages and databases. */
  page_id: string | null;
  properties: Record<string, any>;
  content: string[];
  created_by: string | null;
  created_at: number;
  last_edited_by: string | null;
  last_edited_at: number;
  archived: boolean;
}

/** A block produced by projecting a page document (no bookkeeping columns yet). */
export interface ProjectedBlock {
  id: string;
  type: ContentBlockType;
  parent_id: string;
  properties: Record<string, any>;
  content: string[];
}

/** Tree-shaped input used to seed / hydrate a page document from blocks. */
export interface BlockInput {
  id?: string;
  type: ContentBlockType | "child_page" | "child_database";
  properties?: Record<string, any>;
  children?: BlockInput[];
}

// ---------- databases ----------

export type PropertyType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "person"
  | "relation"
  | "rollup"
  | "formula"
  | "created_time"
  | "last_edited_time"
  | "created_by"
  | "last_edited_by";

export const PROPERTY_TYPES: PropertyType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "person",
  "relation",
  "rollup",
  "formula",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
];

/** Properties whose value is derived, never written to a cell. */
export const COMPUTED_TYPES = new Set<PropertyType>(["rollup", "formula", "created_time", "last_edited_time", "created_by", "last_edited_by"]);

export type RollupFunction =
  | "show_original"
  | "count"
  | "count_values"
  | "count_unique"
  | "count_checked"
  | "percent_checked"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "range"
  | "earliest_date"
  | "latest_date";

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  options?: SelectOption[];
  /** relation: the database whose rows this property links to. */
  relation?: {
    databaseId: string;
    /** Two-way relations: the property on the other database that mirrors this one. */
    syncedPropertyId?: string | null;
  };
  /** rollup: aggregate a property of the rows linked through a relation property. */
  rollup?: { relationPropertyId: string; targetPropertyId: string; function: RollupFunction };
  /** formula: an expression over this row's properties (see formula.ts). */
  formula?: { expression: string };
}

export type FilterOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "before"
  | "after";

export interface ViewFilter {
  property: string;
  operator: FilterOperator;
  value?: any;
}

export interface ViewSort {
  property: string;
  direction: "ascending" | "descending";
}

export type ViewType = "table" | "board" | "calendar" | "gallery";

export interface DatabaseView {
  id: string;
  name: string;
  type: ViewType;
  sorts: ViewSort[];
  filters: ViewFilter[];
  /** Board views group by a select property. */
  groupBy?: string;
  /** Calendar views place rows on this date property. */
  dateProperty?: string;
  /** Gallery views: what fills the top of each card. */
  cardPreview?: "cover" | "none";
}

export interface DatabaseProperties {
  title: string;
  schema: Record<string, PropertyDef>;
  /** Column order. Always starts with "title". */
  order: string[];
  views: DatabaseView[];
}

export interface RowProperties {
  title: string;
  icon?: string | null;
  values: Record<string, any>;
}

export const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
export const TEXT_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
