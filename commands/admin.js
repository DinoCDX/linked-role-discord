export default [
  {
    name: "register_metadata",
    description: "Register role-connection metadata (bot).",
    options: [
      { name: "key", type: 3, description: "metadata key", required: true },
      { name: "name", type: 3, description: "human name", required: true },
      { name: "description", type: 3, description: "description", required: true },
      { name: "type", type: 4, description: "type (1=string,2=boolean,3=integer_equal)", required: true }
    ]
  },
  {
    name: "map_role",
    description: "Map a guild role to a metadata key.",
    options: [
      { name: "source_role", type: 8, description: "role to watch", required: true },
      { name: "metadata_key", type: 3, description: "metadata key to set", required: true }
    ]
  },
  {
    name: "unmap_role",
    description: "Remove mapping for a guild role.",
    options: [{ name: "source_role", type: 8, description: "role to unmap", required: true }]
  }
];
